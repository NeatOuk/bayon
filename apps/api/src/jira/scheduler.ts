import {
  OPERATOR_SETTINGS,
  deltaWindowMinutes,
  operatorSettingSchema,
  type Clock,
  type Result,
} from "@bayon/core";
import { getSettings, jiraSourceOf, listWorkspaces, type Db } from "@bayon/db";
import type { JiraLogger, JiraSync } from "./sync.js";

// The Jira mirror's timer, in the API beside the sync it runs. Two cadences, one loop
//: every `jira.sync_interval_ms` a full sync of each project with a Jira source, which
// alone may park; and every `jira.quick_interval_ms` a quick pass, which reads only the issues
// changed since the last pass of either kind began. The loop runs one pass at a time, so the two
// never overlap; when both are due the full one runs, and it restarts the quick cadence, having
// covered the same ground. Both intervals are read again at every wake, and the timer never sleeps
// longer than a minute, so a change applies within one; 0 turns either off (the button still syncs).
// A project already syncing (its button pressed) is skipped for the tick. A failed pass is audited
// or logged by the sync; nothing a tick meets is ever thrown out of the loop.
//
// Pausing the fleet or a project does not stop the timer: the mirror spawns nothing.

export const JIRA_INTERVAL_KEY = "jira.sync_interval_ms";
export const JIRA_QUICK_INTERVAL_KEY = "jira.quick_interval_ms";
/** The longest the timer sleeps before it reads its settings again: their own minimum. */
export const JIRA_RECHECK_MS = OPERATOR_SETTINGS[JIRA_INTERVAL_KEY].min;

const FullMs = operatorSettingSchema(OPERATOR_SETTINGS[JIRA_INTERVAL_KEY]);
const QuickMs = operatorSettingSchema(
  OPERATOR_SETTINGS[JIRA_QUICK_INTERVAL_KEY],
);

export interface JiraSchedulerDeps {
  readonly db: Db;
  readonly clock: Clock;
  /** The sync it runs: the one the button uses, so a project never syncs twice at once. */
  readonly sync: Pick<JiraSync, "isRunning" | "run" | "quick">;
  readonly logger: JiraLogger;
}

/** Each cadence's interval now; 0 is off. */
interface Intervals {
  readonly full: number;
  readonly quick: number;
}

/** When the last full pass began, and the last pass of either kind. */
interface Started {
  readonly full: number;
  readonly any: number;
}

type Due = "full" | "quick" | null;

/** The pass due at `now`: a full one wins over a quick one. */
function dueAt(now: number, last: Started, iv: Intervals): Due {
  if (iv.full > 0 && now - last.full >= iv.full) return "full";
  if (iv.quick > 0 && now - last.any >= iv.quick) return "quick";
  return null;
}

/** How long to sleep: until the first pass falls due, and never past the recheck. */
function sleepFor(now: number, last: Started, iv: Intervals): number {
  const dues = [
    ...(iv.full > 0 ? [last.full + iv.full] : []),
    ...(iv.quick > 0 ? [last.any + iv.quick] : []),
    now + JIRA_RECHECK_MS,
  ];
  return Math.max(0, Math.min(...dues) - now);
}

export class JiraScheduler {
  readonly #deps: JiraSchedulerDeps;
  #stopper: AbortController | null = null;
  #loop: Promise<void> | null = null;

  constructor(deps: JiraSchedulerDeps) {
    this.#deps = deps;
  }

  /** Starts the timer; a second start while it runs does nothing. */
  start(): void {
    if (this.#loop !== null) return;
    const stopper = new AbortController();
    this.#stopper = stopper;
    this.#loop = this.#run(stopper.signal);
  }

  /** Stops the timer and waits for a tick in flight, whose requests it aborts. */
  async stop(): Promise<void> {
    this.#stopper?.abort();
    await this.#loop;
    this.#stopper = null;
    this.#loop = null;
  }

  /** Both intervals now: an unreadable one is logged and read as off. */
  async #intervals(): Promise<Intervals> {
    const rows = await getSettings(this.#deps.db, [
      JIRA_INTERVAL_KEY,
      JIRA_QUICK_INTERVAL_KEY,
    ]);
    const read = (key: string, schema: typeof FullMs): number => {
      const parsed = rows.ok ? schema.safeParse(rows.value.get(key)) : null;
      if (parsed?.success === true) return parsed.data;
      this.#deps.logger.warn(
        `${key} is unreadable; that Jira timer is off until it is set`,
      );
      return 0;
    };
    return {
      full: read(JIRA_INTERVAL_KEY, FullMs),
      quick: read(JIRA_QUICK_INTERVAL_KEY, QuickMs),
    };
  }

  async #run(signal: AbortSignal): Promise<void> {
    const { clock } = this.#deps;
    const began = clock.now();
    let last: Started = { full: began, any: began };
    let intervals = await this.#intervals();
    for (;;) {
      try {
        await clock.after(sleepFor(clock.now(), last, intervals), signal);
      } catch {
        return; // stop() aborted the wait
      }
      // Read again: a change made while it waited applies now.
      intervals = await this.#intervals();
      // Taken before the pass, so the cadence does not drift by the length of a tick.
      const now = clock.now();
      const due = dueAt(now, last, intervals);
      if (due === "full") {
        await this.tick(signal);
        last = { full: now, any: now };
      } else if (due === "quick") {
        await this.quickTick(deltaWindowMinutes(now - last.any), signal);
        last = { ...last, any: now };
      }
    }
  }

  /** A full pass: each project with a Jira source, in turn. Exposed for the timer's tests. */
  tick(signal?: AbortSignal): Promise<void> {
    return this.#each(signal, (id) => this.#deps.sync.run(id, "timer", signal));
  }

  /** A quick pass over the last `minutes`: each sourced project, in turn. Exposed for its tests. */
  quickTick(minutes: number, signal?: AbortSignal): Promise<void> {
    return this.#each(signal, (id) =>
      this.#deps.sync.quick(id, minutes, signal),
    );
  }

  async #each(
    signal: AbortSignal | undefined,
    pass: (workspaceId: string) => Promise<Result<unknown>>,
  ): Promise<void> {
    const { db, sync, logger } = this.#deps;
    const workspaces = await listWorkspaces(db);
    if (!workspaces.ok) {
      logger.error(
        `the Jira timer could not list projects: ${workspaces.error.message}`,
      );
      return;
    }
    const sourced = workspaces.value.filter((w) => jiraSourceOf(w) !== null);
    for (const w of sourced) {
      if (signal?.aborted === true) return;
      if (sync.isRunning(w.id)) continue;
      try {
        // A failure is already audited or logged by the sync; the next project goes on.
        await pass(w.id);
      } catch (e) {
        logger.error(
          `the Jira timer's sync of ${w.id} threw: ${e instanceof Error ? e.message : "unknown"}`,
        );
      }
    }
  }
}
