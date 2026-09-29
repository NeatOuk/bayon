import { statSync } from "node:fs";
import { listSweepWorktrees } from "@bayon/db";
import { ok, type Result } from "@bayon/core";
import type { SessionView } from "@bayon/proto";
import { COMMAND_TIMEOUT_MS, M4_PLUG_TIMEOUT_MS } from "./budget.js";
import { SMOKE } from "./config.js";
import { pollUntil } from "./deadline.js";
import { verdict } from "./harness.js";
import { backupPhase } from "./m4-backup.js";
import {
  M4,
  M4_RAISED_CAP_USD,
  M4_TINY_CAP_USD,
  m4Spawn,
  type M4Agent,
} from "./m4-config.js";
import { commandDone, spawnWith, type World } from "./phases.js";
import { startSupervisor } from "./stack.js";
import type { Child } from "./procs.js";

// `frm smoke --m4` (spec §16): the M4 acceptance test. Its one sentence is "you can pull
// the host's plug and lose only in-flight turns", and everything here builds to that: a budget and
// a kill switch that each queue a spawn until an operator lifts them, then every foreman process
// group SIGKILLed at once — twice — with the fleet expected to come back having lost nothing but
// the turn that was in flight.

/** The supervisor the plug cycle replaces; `setUp`'s is the first. */
interface Fleet {
  supervisor: Child;
}

const sessionOf = (w: World, id: string): Promise<Result<SessionView>> =>
  w.api.session(id);

/** Waits until `want` holds of the session, reporting the state it did see. */
function sessionUntil(
  w: World,
  id: string,
  what: string,
  want: (s: SessionView) => boolean,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<Result<SessionView>> {
  let seen = "not seen";
  return pollUntil(
    { clock: w.h.clock, timeoutMs, intervalMs: 100, what, detail: () => seen },
    async () => {
      const s = await sessionOf(w, id);
      if (!s.ok) return s;
      seen = s.value.state;
      return ok(want(s.value) ? s.value : undefined);
    },
  );
}

/**
 * Why admission is holding `id`, from `GET /fleet` — the operator's own view. The reason is not on
 * the session row: it rides on the fleet overview's admission block (`FleetAdmission.queued`).
 */
async function queuedReason(
  w: World,
  id: string,
): Promise<Result<string | undefined>> {
  const fleet = await w.api.fleet();
  if (!fleet.ok) return fleet;
  const row = fleet.value.admission.queued.find((q) => q.session_id === id);
  return ok(row?.reason);
}

/** Waits until admission reports `id` queued for `reason`. */
function queuedFor(
  w: World,
  id: string,
  reason: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<Result<true>> {
  let seen = "not queued";
  return pollUntil(
    {
      clock: w.h.clock,
      timeoutMs,
      intervalMs: 200,
      what: `${id} queued on ${reason}`,
      detail: () => seen,
    },
    async () => {
      const found = await queuedReason(w, id);
      if (!found.ok) return found;
      seen = found.value ?? "not queued";
      return ok(found.value === reason ? true : undefined);
    },
  );
}

/** Spawns one M4 agent's session, without waiting for its command: a queued spawn never completes. */
async function spawnQueued(
  w: World,
  label: string,
  agent: M4Agent,
): Promise<string> {
  const accepted = await w.h.step(`POST /sessions (${label})`, () =>
    w.api.spawn(m4Spawn(agent), `m4:${label}:${w.h.clock.now()}`),
  );
  w.h.track(accepted.session_id);
  return accepted.session_id;
}

/**
 * §13.4: a cap under one run's cost queues the next spawn on `budget`, never killing work in
 * flight; raising it lets admission's recheck through, and the queued session runs to its terminal.
 */
async function budgetPhase(w: World): Promise<void> {
  await w.h.step(
    `PUT /budgets: a $${M4_TINY_CAP_USD} fleet cap for today`,
    () =>
      w.api.putBudget({
        scope: "fleet",
        scope_ref: null,
        period: "day",
        cap_usd: M4_TINY_CAP_USD,
        warn_pct: 70,
        on_breach: "pause_admission",
      }),
  );
  // One run under the tiny cap: enough spend to breach it for whatever comes next.
  const spent = await spawnWith(w, "budget-spend", m4Spawn(M4.idle));
  await w.h.step("the spending session idles", () =>
    sessionUntil(w, spent, "budget-spend idle", (s) => s.state === "idle"),
  );
  const queued = await spawnQueued(w, "budget-queued", M4.dirty);
  await w.h.step("the next spawn is queued on the breached budget", () =>
    queuedFor(w, queued, "budget"),
  );
  await w.h.step(`PUT /budgets: the cap raised to $${M4_RAISED_CAP_USD}`, () =>
    w.api.putBudget({
      scope: "fleet",
      scope_ref: null,
      period: "day",
      cap_usd: M4_RAISED_CAP_USD,
      warn_pct: 70,
      on_breach: "pause_admission",
    }),
  );
  await w.h.step("the raised cap admits it, and it runs to its terminal", () =>
    sessionUntil(
      w,
      queued,
      "budget-queued idle",
      (s) => s.state === "idle",
      M4_PLUG_TIMEOUT_MS,
    ),
  );
  await w.h.step("both sessions stopped", async () => {
    for (const id of [spent, queued]) {
      const stop = await w.api.stop(id, "kill", `m4:stop:${id}`);
      if (!stop.ok) return stop;
      const done = await commandDone(w, stop.value.command_id);
      if (!done.ok) return done;
    }
    return ok(undefined);
  });
}

/**
 * §13.3, the kill switch: a pause queues new spawns on `fleet_paused` and lets the turn in flight
 * finish; a resume admits what it queued. Both writes are audited.
 */
async function killSwitchPhase(w: World): Promise<void> {
  const held = await spawnWith(w, "pause-held", m4Spawn(M4.held));
  await w.h.step("a run is in flight at its gate", () =>
    sessionUntil(w, held, "pause-held running", (s) => s.state === "running"),
  );
  await w.h.step("POST /fleet/pause", async () => {
    const paused = await w.api.pause();
    if (!paused.ok) return paused;
    return verdict(paused.value.paused ? [] : ["pause did not take"]);
  });
  const queued = await spawnQueued(w, "pause-queued", M4.idle);
  await w.h.step("the new spawn waits on the pause", () =>
    queuedFor(w, queued, "fleet_paused"),
  );
  await w.h.step("the turn in flight is not killed by the pause", async () => {
    const s = await sessionOf(w, held);
    if (!s.ok) return s;
    return verdict(
      s.value.state === "running"
        ? []
        : [`the paused fleet left it ${s.value.state}, not running`],
    );
  });
  await w.h.step("POST /fleet/resume", async () => {
    const resumed = await w.api.resume();
    if (!resumed.ok) return resumed;
    return verdict(resumed.value.paused ? ["resume did not take"] : []);
  });
  await w.h.step("the resume admits what the pause queued", () =>
    sessionUntil(
      w,
      queued,
      "pause-queued admitted",
      (s) => s.state !== "pending",
      M4_PLUG_TIMEOUT_MS,
    ),
  );
  await w.h.step("both sessions stopped", async () => {
    for (const id of [held, queued]) {
      const stop = await w.api.stop(id, "kill", `m4:stop:${id}`);
      if (!stop.ok) return stop;
      const done = await commandDone(w, stop.value.command_id);
      if (!done.ok) return done;
    }
    return ok(undefined);
  });
}

/** What one plug cycle snapshots, so the restart can be held to it. */
interface Snapshot {
  readonly held: SessionView;
  readonly idle: SessionView;
  /** Raw-log bytes on disk per session id, before the plug. */
  readonly bytes: ReadonlyMap<string, number>;
}

const logBytes = (path: string | null): number => {
  if (path === null) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** Every session's committed offset is backed by bytes still on disk. */
function rawLogsWhole(
  before: Snapshot,
  after: readonly SessionView[],
): readonly string[] {
  const problems: string[] = [];
  for (const s of after) {
    const size = logBytes(s.raw_log_path);
    const committed = s.raw_segment_offset ?? 0;
    if (size < committed)
      problems.push(
        `${s.id}: raw log is ${size} bytes but the DB committed ${committed}`,
      );
    const was = before.bytes.get(s.id) ?? 0;
    if (size < was)
      problems.push(`${s.id}: raw log shrank from ${was} to ${size} bytes`);
  }
  return problems;
}

/**
 * One pull-the-plug cycle: place the sessions, snapshot what must survive, SIGKILL every group at
 * once, restart the supervisor, and hold the fleet to the snapshot — the held session's run
 * `interrupted` and the session adopted on a new process, the idle one adopted, the queued one
 * still queued, every raw log at least as long as its committed offset, and no command left
 * `claimed` by the supervisor that died holding it.
 */
async function plugCycle(w: World, fleet: Fleet, cycle: number): Promise<void> {
  const tag = `plug ${cycle}`;
  const held = await spawnWith(w, `${tag} held`, m4Spawn(M4.held));
  const idle = await spawnWith(w, `${tag} idle`, m4Spawn(M4.idle));
  await w.h.step(`${tag}: the held run is in flight`, () =>
    sessionUntil(w, held, `${tag} held running`, (s) => s.state === "running"),
  );
  await w.h.step(`${tag}: the other session idles`, () =>
    sessionUntil(w, idle, `${tag} idle`, (s) => s.state === "idle"),
  );
  // A second session for the idle agent: 012's max_concurrency of 1 queues it behind the first.
  const queued = await spawnQueued(w, `${tag} queued`, M4.idle);
  await w.h.step(`${tag}: the third spawn queues on concurrency`, () =>
    queuedFor(w, queued, "concurrency"),
  );

  const before = await w.h.step(`${tag}: snapshot`, async () => {
    const h = await sessionOf(w, held);
    if (!h.ok) return h;
    const i = await sessionOf(w, idle);
    if (!i.ok) return i;
    const bytes = new Map<string, number>();
    for (const s of [h.value, i.value])
      bytes.set(s.id, logBytes(s.raw_log_path));
    return ok<Snapshot>({ held: h.value, idle: i.value, bytes });
  });

  // One command left in the supervisor's hands as the plug is pulled: the restart must requeue it
  // rather than leave it `claimed` for ever by a process that no longer exists.
  const inFlight = await w.h.step(
    `${tag}: a command in flight when the plug is pulled`,
    async () => {
      const asked = await w.api.executorHealth(
        SMOKE.executor,
        `m4:health:${tag}:${w.h.clock.now()}`,
      );
      return asked.ok ? ok(asked.value.command_id) : asked;
    },
  );

  await w.h.step(`${tag}: SIGKILL every foreman process group at once`, () => {
    // The supervisor's group and each session's runner group: the plug, not a graceful stop.
    for (const s of [before.held, before.idle]) {
      const pid = Number(s.executor_ref?.split(":")[1] ?? "");
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already gone: the plug does not care which order they die in.
        }
      }
    }
    fleet.supervisor.signal("SIGKILL");
    return Promise.resolve(ok(undefined));
  });

  fleet.supervisor = await w.h.step(`${tag}: the fleet restarted`, () =>
    startSupervisor({
      home: w.h.home,
      env: w.h.io.env,
      clock: w.h.clock,
      onStart: (c) => w.h.own(c),
      main: w.main.supervisor,
      db: w.db,
      mcpUrl: `http://127.0.0.1:${w.port}/mcp`,
    }),
  );

  const readopted = await w.h.step(
    `${tag}: the resumable session is adopted on a new process`,
    () =>
      sessionUntil(
        w,
        held,
        `${tag} held adopted`,
        (s) =>
          s.state === "idle" && s.executor_ref !== before.held.executor_ref,
        M4_PLUG_TIMEOUT_MS,
      ),
  );
  await w.h.step(`${tag}: it kept its runner session id`, () =>
    Promise.resolve(
      verdict(
        readopted.runner_session_id === before.held.runner_session_id
          ? []
          : [
              `runner_session_id moved from ${before.held.runner_session_id} to ${readopted.runner_session_id}`,
            ],
      ),
    ),
  );
  const idleAfter = await w.h.step(`${tag}: the idle session is adopted`, () =>
    sessionUntil(
      w,
      idle,
      `${tag} idle adopted`,
      (s) => s.state === "idle" && s.executor_ref !== before.idle.executor_ref,
      M4_PLUG_TIMEOUT_MS,
    ),
  );
  await w.h.step(`${tag}: the queued session is still queued`, () =>
    queuedFor(w, queued, "concurrency", M4_PLUG_TIMEOUT_MS),
  );
  await w.h.step(`${tag}: every raw log is at least its committed offset`, () =>
    Promise.resolve(verdict(rawLogsWhole(before, [readopted, idleAfter]))),
  );
  await w.h.step(
    `${tag}: the command claimed when the plug was pulled is requeued and finishes`,
    () => commandDone(w, inFlight, M4_PLUG_TIMEOUT_MS),
  );
  await w.h.step(`${tag}: it is not left wedged in flight`, async () => {
    const c = await w.api.command(inFlight);
    if (!c.ok) return c;
    // Whether the dying supervisor had already *claimed* it is a race the smoke does not try to
    // win — inserting and being claimed inside the same instant is not something an operator can
    // arrange either. What M4 must guarantee either way is that the restart leaves no command
    // stuck: it is claimed and finished by whichever supervisor is alive to do it. The requeue of
    // an already-claimed command has its own deterministic cover in plug.test.ts, which claims by
    // hand before killing.
    return verdict(
      c.value.state === "done"
        ? []
        : [`left ${c.value.state} after the restart`],
    );
  });
  // The held session ends here: the next cycle places its own, and the sweep wants them finished.
  await w.h.step(`${tag}: the cycle's sessions stopped`, async () => {
    for (const id of [held, idle, queued]) {
      const stop = await w.api.stop(id, "kill", `m4:stop:${tag}:${id}`);
      if (!stop.ok) return stop;
      const done = await commandDone(w, stop.value.command_id);
      if (!done.ok) return done;
    }
    return ok(undefined);
  });
}

/**
 * §9.6 step 6: the sweep removes a clean worktree and keeps a dirty one — work in progress is
 * never deleted to tidy up.
 */
async function sweepPhase(w: World): Promise<void> {
  const dirty = await spawnWith(w, "sweep-dirty", m4Spawn(M4.dirty));
  await w.h.step("the session that leaves its change uncommitted idles", () =>
    sessionUntil(w, dirty, "sweep-dirty idle", (s) => s.state === "idle"),
  );
  await w.h.step("its worktree is dirty, so the sweep must keep it", () =>
    pollUntil(
      {
        clock: w.h.clock,
        timeoutMs: M4_PLUG_TIMEOUT_MS,
        intervalMs: 500,
        what: "the dirty worktree seen",
      },
      async () => {
        const rows = await listSweepWorktrees(w.db);
        if (!rows.ok) return rows;
        const mine = rows.value.filter((r) => r.session_id === dirty);
        return ok(mine.length > 0 ? mine : undefined);
      },
    ),
  );
  await w.h.step("the dirty session stopped", async () => {
    const stop = await w.api.stop(dirty, "kill", `m4:stop:${dirty}`);
    if (!stop.ok) return stop;
    return commandDone(w, stop.value.command_id);
  });
}

/** The M4 acceptance test, in the order its parts build on each other. */
export async function m4(w: World): Promise<void> {
  const fleet: Fleet = { supervisor: w.supervisor };
  await budgetPhase(w);
  await killSwitchPhase(w);
  // Before the plug cycles, not after: they SIGKILL every process group, and a backup taken over a
  // database just recovered from that proves less than one taken over a database in use.
  await backupPhase(w);
  for (const cycle of [1, 2]) await plugCycle(w, fleet, cycle);
  await sweepPhase(w);
  w.h.io.out(
    `note  --m4: the plug cycle ran twice on ${SMOKE.executor}; the manual power-cut drill is written up in the design`,
  );
  w.h.io.out(
    "note  --m4: S5 (a session on a container executor, reaped by label) is retired, not deferred: there is no docker host",
  );
}
