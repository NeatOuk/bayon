// The runner update check: once at boot, then every `runners.update_check_hours` (0 =
// off). For each adapter that declares `updateCheck`, one call bounded by 10 s on the injected
// clock plus the job's own stop signal; a good answer is recorded, a bad one is logged and skipped
// — the other adapters still run. Nothing here ever installs or upgrades anything.
import { compareVersions, err, ok, type Clock, type Result } from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { recordRunnerUpdate } from "@bayon/db/supervisor";
import type { RunnerAdapter, RunnerUpdate } from "@bayon/runners";
import type { Logger } from "pino";
import { z } from "zod";
import { asFrmError, frmError } from "../lifecycle/errors.js";

const HOUR_MS = 3_600_000;
/** How often a waiting scheduler re-reads its setting, so a change is seen within the hour. */
export const UPDATE_CHECK_RECHECK_MS = HOUR_MS;
/** How long one adapter's check may run before it is abandoned. */
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;

const Settings = z.object({
  "runners.update_check_hours": z.int().min(0).max(168).default(24),
});

/** `runners.update_check_hours`, read fresh: 0 means the check is off. */
export async function loadUpdateCheckHours(db: Db): Promise<Result<number>> {
  const rows = await getSettings(db, Object.keys(Settings.shape));
  if (!rows.ok) return rows;
  const parsed = Settings.safeParse(Object.fromEntries(rows.value));
  return parsed.success
    ? ok(parsed.data["runners.update_check_hours"])
    : err(
        frmError(
          "validation",
          `runners.update_check_hours: ${z.prettifyError(parsed.error)}`,
        ),
      );
}

/**
 * One adapter's `updateCheck`, bounded by `UPDATE_CHECK_TIMEOUT_MS` on `clock` and by `stopSignal`.
 * Never throws: a timeout or a stop is a plain `timeout`/`interrupted` result, like any other.
 */
async function boundedCheck(
  adapter: RunnerAdapter,
  clock: Clock,
  stopSignal: AbortSignal,
): Promise<Result<RunnerUpdate>> {
  if (adapter.updateCheck === undefined) {
    return err(frmError("validation", "this adapter has no updateCheck"));
  }
  if (stopSignal.aborted) {
    return err(frmError("interrupted", "the update-check job is stopping"));
  }
  const fetchAbort = new AbortController();
  const onStop = (): void => fetchAbort.abort();
  stopSignal.addEventListener("abort", onStop, { once: true });
  try {
    const result = await Promise.race([
      adapter
        .updateCheck({ fetch: globalThis.fetch, signal: fetchAbort.signal })
        .then((r) => ({ tag: "done" as const, r })),
      clock
        .after(UPDATE_CHECK_TIMEOUT_MS, fetchAbort.signal)
        .then(() => ({ tag: "timeout" as const }))
        .catch(() => ({ tag: "aborted" as const })),
    ]);
    if (result.tag === "done") {
      // The check won the race: cancel the still-pending timeout timer rather than leaving it
      // armed for the full 10 s (a real setTimeout, or a FakeClock timer that outlives this test).
      fetchAbort.abort();
      return result.r;
    }
    fetchAbort.abort();
    return err(
      result.tag === "timeout"
        ? frmError(
            "timeout",
            `${adapter.id}: update check did not answer within ${UPDATE_CHECK_TIMEOUT_MS} ms`,
          )
        : frmError("interrupted", `${adapter.id}: update check stopped`),
    );
  } catch (e) {
    return err(
      asFrmError(e, "runner_error", `${adapter.id}: update check failed`),
    );
  } finally {
    stopSignal.removeEventListener("abort", onStop);
  }
}

export interface UpdateCheckPassOptions {
  readonly db: Db;
  readonly clock: Clock;
  /** Every registry adapter; only those with `updateCheck` are asked (Invariant 1: no string here). */
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
  readonly log: Logger;
  readonly signal: AbortSignal;
}

/** One pass over every adapter that declares `updateCheck`. Never throws; never stops early on a failure. */
export async function runUpdateCheckPass(
  o: UpdateCheckPassOptions,
): Promise<void> {
  for (const [runnerId, adapter] of o.adapters) {
    if (adapter.updateCheck === undefined) continue;
    if (o.signal.aborted) return;
    const checked = await boundedCheck(adapter, o.clock, o.signal);
    if (!checked.ok) {
      o.log.warn(
        { runner: runnerId, error: checked.error },
        "runner update check failed",
      );
      continue;
    }
    const { current, latest, notes_url } = checked.value;
    const recorded = await recordRunnerUpdate(o.db, {
      runner_id: runnerId,
      current,
      latest,
      newer: compareVersions(latest, current) > 0,
      ...(notes_url === undefined ? {} : { notes_url }),
    });
    if (!recorded.ok) {
      o.log.warn(
        { runner: runnerId, error: recorded.error },
        "cannot record a runner update check",
      );
    }
  }
}

export interface UpdateCheckSchedulerOptions {
  readonly clock: Clock;
  readonly loadHours: () => Promise<Result<number>>;
  /** One pass, given the signal that `stop()` aborts. */
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly recheckMs?: number;
}

export interface UpdateCheckScheduler {
  start(): void;
  /** Cancels the wait and any check in flight, and resolves once its pass has stopped. Idempotent. */
  stop(): Promise<void>;
}

/**
 * `createBackupScheduler`'s shape (jobs/backup-schedule.ts): a pass at boot, then every
 * `runners.update_check_hours`, re-read at least hourly so a change takes effect within it. 0 turns
 * the check off (nothing fetched) without stopping the loop, so raising it later is picked up too.
 */
export function createUpdateCheckScheduler(
  o: UpdateCheckSchedulerOptions,
): UpdateCheckScheduler {
  const abort = new AbortController();
  const recheck = o.recheckMs ?? UPDATE_CHECK_RECHECK_MS;
  let started = false;
  let running: Promise<void> = Promise.resolve();
  /** The next pass is due at or before this; 0 means due now (the boot pass). */
  let nextRunAt = 0;

  async function tick(): Promise<number> {
    const hours = await o.loadHours();
    if (!hours.ok) {
      o.onError(hours.error);
      return recheck;
    }
    if (hours.value === 0) return recheck; // off: re-read hourly in case it is turned back on
    const now = o.clock.now();
    if (now >= nextRunAt && !abort.signal.aborted) {
      await o.run(abort.signal);
      nextRunAt = o.clock.now() + hours.value * HOUR_MS;
    }
    return Math.min(nextRunAt - o.clock.now(), recheck);
  }

  function loop(): void {
    running = (async () => {
      let wait = recheck;
      try {
        wait = await tick();
      } catch (e) {
        o.onError(e);
      }
      if (abort.signal.aborted) return;
      o.clock.after(wait, abort.signal).then(loop, () => undefined);
    })();
  }

  return {
    start() {
      if (started) return;
      started = true;
      loop();
    },
    async stop() {
      abort.abort();
      await running;
    },
  };
}
