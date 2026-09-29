import { FakeClock } from "@bayon/core";
import {
  getTicket,
  hasOpenSystemRequest,
  listInboxRequests,
  listTicketEvents,
  listTicketHumanRequests,
  type Db,
} from "@bayon/db";
import {
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type SeedRows,
} from "@bayon/db/testing";
import type { Executor, PipeRelease } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import type { SessionHandle } from "@bayon/runners";
import { pino } from "pino";
import { afterAll, describe, expect, test, vi } from "vitest";
import { KeyedQueue } from "../lifecycle/session-queue.js";
import { ReleaseCandidates } from "./candidates.js";
import type { WatchdogDeps } from "./ports.js";
import { DRAIN_CAP_GRACES } from "./stuck.js";
import { createWatchdog } from "./watchdog.js";

// The watchdog, one test per §13.2 row, on a real temp database
// and a FakeClock: no sleeps.

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 14, 12);
const GRACE = 5_000;
const log = pino({ level: "silent" });

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

async function world(start = T0) {
  const clock = new FakeClock(start);
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 14));
  return { db: t.db, clock };
}

function deps(
  db: Db,
  clock: FakeClock,
  o: Partial<WatchdogDeps> = {},
): WatchdogDeps {
  return {
    db,
    clock,
    log,
    candidates: new ReleaseCandidates(),
    killGraceMs: () => GRACE,
    probeTimeoutMs: () => 1_000,
    liveProcesses: () => [],
    checkCeilings: () => undefined,
    // The stub below measures it; the path only has to be there.
    diskPaths: ["/"],
    freePct: async () => 50,
    ...o,
  };
}

type SessionSeed = NonNullable<SeedRows["sessions"]>[number];
type RunSeed = NonNullable<SeedRows["runs"]>[number];

let seq = 0;
const failedRun = (
  sessionId: string,
  at: number,
  o: Partial<RunSeed> = {},
): RunSeed => {
  seq += 1;
  return {
    ...newRunInput(sessionId),
    id: `run-${seq}`,
    seq,
    state: "failed",
    error_class: "runner_exited_without_terminal",
    started_at: at - 1,
    ended_at: at,
    ...o,
  };
};
const holder = (
  id: string,
  ticketId: string,
  o: Partial<SessionSeed> = {},
): SessionSeed => ({
  ...newSessionInput(),
  id,
  ticket_id: ticketId,
  state: "exited",
  created_at: 0,
  ...o,
});

/**
 * A `session.spawn` that failed before writing its session row: the session id it names has no row,
 * which is what tells the breaker no other source has counted this failure.
 */
const failedSpawn = (
  n: number,
  ticketId: string,
  ts: number,
  errorClass = "not_found",
) => ({
  id: `cmd-${n}`,
  ts,
  type: "session.spawn",
  payload_json: JSON.stringify({
    session_id: `never-written-${n}`,
    ticket_id: ticketId,
    role: "builder",
  }),
  state: "failed" as const,
  attempts: 1,
  error: JSON.stringify({
    class: errorClass,
    message: "the spawn never started",
    retryable: false,
  }),
});

describe("circuit breaker", () => {
  test("3 failed runs block the ticket through the law with one request; later ticks file nothing", async () => {
    const { db, clock } = await world();
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(1, { status: "building", created_at: T0 - HOUR })],
        sessions: [holder("s1", "ticket-1")],
        runs: [1, 2, 3].map((i) => failedRun("s1", T0 - 10 * i)),
      }),
    );
    const w = createWatchdog(deps(db, clock));
    await w.tick();
    const ticket = unwrap(await getTicket(db, "ticket-1"));
    expect(ticket.status).toBe("blocked");
    expect(ticket.blocked_reason).toMatch(/^circuit breaker: 3 failed runs/);
    const requests = unwrap(await listTicketHumanRequests(db, "ticket-1", 10));
    expect(requests.map((r) => r.kind)).toEqual(["circuit_breaker"]);
    const events = unwrap(
      await listTicketEvents(db, {
        ticket_id: "ticket-1",
        since: 0,
        limit: 100,
      }),
    );
    expect(
      events.rows
        .filter((e) => e.kind === "transition")
        .map((e) => e.actor_kind),
    ).toEqual(["supervisor"]);
    await w.tick();
    w.sessionEnded({
      sessionId: "s1",
      ticketId: "ticket-1",
      workspaceId: null,
      at: T0,
      handoffPending: false,
    });
    await w.settled();
    expect(
      unwrap(await listTicketHumanRequests(db, "ticket-1", 10)),
    ).toHaveLength(1);
  });

  test("restarts, interruptions, refusals and deaths while queued never count", async () => {
    const { db, clock } = await world();
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(2, { status: "building", created_at: T0 - HOUR })],
        sessions: [
          holder("s2", "ticket-2"),
          holder("q2", "ticket-2", {
            exit_reason: "error",
            error_class: "timeout",
            queued_reason: "fleet_paused",
            ended_at: T0 - 5,
          }),
        ],
        runs: [
          failedRun("s2", T0 - 10, { error_class: "supervisor_restart" }),
          failedRun("s2", T0 - 20, { error_class: "interrupted" }),
          failedRun("s2", T0 - 30, { error_class: "admission_refused" }),
          failedRun("s2", T0 - 40, { state: "interrupted" }),
        ],
      }),
    );
    const w = createWatchdog(deps(db, clock));
    await w.tick();
    expect(unwrap(await getTicket(db, "ticket-2")).status).toBe("building");
    expect(unwrap(await w.circuit.check("ticket-2"))).toEqual({
      state: "closed",
      failures: 0,
      threshold: 3,
    });
  });

  test("3 spawn commands that never wrote a session block the staffed ticket", async () => {
    // Staffing moved the ticket to `staffed` with its command, so a spawn that fails before the
    // session row exists leaves nothing else to count: no run, no session, no hand-off.
    const { db, clock } = await world();
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(7, { status: "staffed", created_at: T0 - HOUR })],
        commands: [1, 2, 3].map((i) => failedSpawn(i, "ticket-7", T0 - i)),
      }),
    );
    const w = createWatchdog(deps(db, clock));
    await w.tick();
    const ticket = unwrap(await getTicket(db, "ticket-7"));
    expect(ticket.status).toBe("blocked");
    const requests = unwrap(await listTicketHumanRequests(db, "ticket-7", 10));
    expect(requests.map((r) => r.kind)).toEqual(["circuit_breaker"]);
  });

  test("one failed spawn command is a hiccup, not a block", async () => {
    const { db, clock } = await world();
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(8, { status: "staffed", created_at: T0 - HOUR })],
        commands: [failedSpawn(8, "ticket-8", T0 - 1)],
      }),
    );
    const w = createWatchdog(deps(db, clock));
    await w.tick();
    expect(unwrap(await getTicket(db, "ticket-8")).status).toBe("staffed");
    expect(unwrap(await w.circuit.check("ticket-8"))).toMatchObject({
      state: "closed",
      failures: 1,
    });
  });

  test("an interrupted attempt cap is the fleet's fault, not the ticket's: it never trips", async () => {
    // The supervisor kept dying under it. Excluded exactly as a restart-interrupted session is.
    const { db, clock } = await world();
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(9, { status: "staffed", created_at: T0 - HOUR })],
        commands: [1, 2, 3].map((i) =>
          failedSpawn(20 + i, "ticket-9", T0 - i, "interrupted"),
        ),
      }),
    );
    const w = createWatchdog(deps(db, clock));
    await w.tick();
    expect(unwrap(await getTicket(db, "ticket-9")).status).toBe("staffed");
  });

  test("a spawn command whose session row exists is counted once, by the session", async () => {
    // Otherwise every failed start would count twice: once as the session, once as its command.
    const { db, clock } = await world();
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(10, { status: "staffed", created_at: T0 - HOUR })],
        sessions: [
          holder("sp-1", "ticket-10", {
            exit_reason: "error",
            error_class: "spawn_failed",
            ended_at: T0 - 1,
          }),
        ],
        // The command names the session that *does* exist, which is the whole point here.
        commands: [
          {
            ...failedSpawn(30, "ticket-10", T0 - 1),
            payload_json: JSON.stringify({
              session_id: "sp-1",
              ticket_id: "ticket-10",
              role: "builder",
            }),
          },
        ],
      }),
    );
    const w = createWatchdog(deps(db, clock));
    expect(unwrap(await w.circuit.check("ticket-10"))).toMatchObject({
      state: "closed",
      failures: 1,
    });
  });

  test("a storm's failures are the storm's, even after its hold lapsed: nothing trips", async () => {
    const { db, clock } = await world(T0 + 2 * HOUR);
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(3, { status: "building", created_at: T0 - HOUR })],
        sessions: [
          holder("s3", "ticket-3"),
          holder("other", "ticket-3", { role: "reviewer" }),
        ],
        runs: [
          ...[0, 1, 2].map((i) =>
            failedRun("s3", T0 + i * MIN, { error_class: "runner_error" }),
          ),
          // The rest of the burst on the same pair, from another session.
          ...[3, 4].map((i) =>
            failedRun("other", T0 + i * MIN, { error_class: "runner_error" }),
          ),
        ],
      }),
    );
    const w = createWatchdog(deps(db, clock));
    await w.tick();
    expect(unwrap(await getTicket(db, "ticket-3")).status).toBe("building");
  });

  test("3 failed starts with no run trip it, and check() answers after the write; a parked ticket is held", async () => {
    const { db, clock } = await world();
    unwrap(
      await seedRows(db, {
        tickets: [
          ticketRow(4, { status: "review_fix", created_at: T0 - HOUR }),
          ticketRow(5, { status: "parked" }),
        ],
        sessions: [1, 2, 3].map((i) =>
          holder(`start-${i}`, "ticket-4", {
            exit_reason: "error",
            error_class: "spawn_failed",
            ended_at: T0 - i,
          }),
        ),
      }),
    );
    const w = createWatchdog(deps(db, clock));
    const verdict = unwrap(await w.circuit.check("ticket-4"));
    expect(verdict).toMatchObject({
      state: "tripped",
      failures: 3,
      newly: true,
    });
    expect(unwrap(await getTicket(db, "ticket-4")).status).toBe("blocked");
    expect(unwrap(await w.circuit.check("ticket-4"))).toEqual({
      state: "held",
      status: "blocked",
    });
    expect(unwrap(await w.circuit.check("ticket-5"))).toEqual({
      state: "held",
      status: "parked",
    });
  });

  test("check() from inside a session op resolves while a tick queues work on that session (MEDIUM-1)", async () => {
    const { db, clock } = await world();
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(6, { status: "building", created_at: T0 - HOUR })],
      }),
    );
    const queue = new KeyedQueue();
    let ceilingRan = false;
    const w = createWatchdog(
      deps(db, clock, {
        checkCeilings: () => {
          void queue.run("S", async () => {
            ceilingRan = true;
          });
        },
      }),
    );
    const inside = await queue.run("S", async () => {
      const ticking = w.tick();
      const verdict = await w.circuit.check("ticket-6");
      return { verdict, ticking };
    });
    await inside.ticking;
    expect(unwrap(inside.verdict).state).toBe("closed");
    await queue.settled();
    expect(ceilingRan).toBe(true);
  });
});

describe("retry storm", () => {
  test("one open request per pair; a new outage files only once the open one is answered", async () => {
    const { db, clock } = await world(T0 + 5 * MIN);
    unwrap(
      await seedRows(db, {
        sessions: [holder("storm", "", { ticket_id: null })],
        runs: [0, 1, 2, 3, 4].map((i) =>
          failedRun("storm", T0 + i * MIN, { error_class: "runner_error" }),
        ),
      }),
    );
    const w = createWatchdog(deps(db, clock));
    const storms = async () =>
      unwrap(
        await listInboxRequests(db, { status: "open", limit: 100 }),
      ).rows.filter((r) => r.kind === "retry_storm");
    await w.tick();
    await w.tick();
    expect(
      unwrap(await hasOpenSystemRequest(db, "retry_storm:fixture/local:")),
    ).toBe(true);
    expect(await storms()).toHaveLength(1);
    // A success on the pair moves the recovery point; the open request still holds a second.
    unwrap(
      await seedRows(db, {
        runs: [
          failedRun("storm", T0 + 5 * MIN - 1, {
            state: "ok",
            error_class: null,
          }),
        ],
      }),
    );
    await w.tick();
    expect(await storms()).toHaveLength(1);
  });
});

describe("split question", () => {
  test("one request per ticket per threshold; the status never changes", async () => {
    const { db, clock } = await world();
    const handoff = (id: string, quality = "full") => ({
      id,
      ticket_id: "ticket-7",
      reason: "context_ceiling",
      facts_json: "{}",
      quality,
      packet_path: ".foreman/handoff.md",
      packet_hash: "0".repeat(64),
      created_at: T0,
    });
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(7, { status: "building" })],
        handoffs: [
          handoff("h1"),
          handoff("h2", "degraded"),
          handoff("h3"),
          handoff("h4"),
        ],
      }),
    );
    const w = createWatchdog(deps(db, clock));
    await w.tick();
    w.handoffPending({
      handoffId: "h4",
      ticketId: "ticket-7",
      workspaceId: null,
      quality: "full",
      at: T0,
    });
    await w.settled();
    const first = unwrap(await listTicketHumanRequests(db, "ticket-7", 10));
    expect(first.filter((r) => r.kind === "split")).toHaveLength(1);
    expect(first[0]?.context_md).toMatch(/4 hand-offs, 1 of them degraded/);
    // A fifth hand-off at the same threshold asks nothing; raising the threshold asks once more.
    unwrap(
      await seedRows(db, {
        handoffs: [handoff("h5")],
        settings: [
          {
            key: "autosplit.handoff_threshold",
            value_json: "5",
            updated_at: T0,
          },
        ],
      }),
    );
    await w.tick();
    await w.tick();
    const second = unwrap(await listTicketHumanRequests(db, "ticket-7", 10));
    expect(second.filter((r) => r.kind === "split")).toHaveLength(2);
    expect(unwrap(await getTicket(db, "ticket-7")).status).toBe("building");
  });
});

describe("low disk", () => {
  test("asks retention once per UTC day while the supervisor's disk is low", async () => {
    const { db, clock } = await world();
    const reasons: string[] = [];
    let free = 5;
    const w = createWatchdog(deps(db, clock, { freePct: async () => free }));
    w.useRetention(async (reason) => {
      reasons.push(reason);
    });
    await w.tick();
    await w.tick();
    expect(reasons).toHaveLength(1);
    await clock.advance(24 * HOUR);
    await w.tick();
    expect(reasons).toHaveLength(2);
    free = 50;
    await clock.advance(24 * HOUR);
    await w.tick();
    expect(reasons).toHaveLength(2);
  });

  // unlike retention's once-a-day ask, a disk that stays low keeps asking for a sweep —
  // the sweep coalesces the repeats itself, so asking on every tick costs nothing.
  test("asks the worktree sweep for a pass on every low tick, and none while the disk is fine", async () => {
    const { db, clock } = await world();
    let sweeps = 0;
    let free = 5;
    const w = createWatchdog(
      deps(db, clock, {
        freePct: async () => free,
        requestSweep: () => {
          sweeps += 1;
        },
      }),
    );

    await w.tick();
    await w.tick();
    expect(sweeps).toBe(2);

    free = 50;
    await clock.advance(24 * HOUR);
    await w.tick();
    expect(sweeps).toBe(2);
  });

  test("asks for a sweep even when no retention is wired, and the tick still finishes", async () => {
    const { db, clock } = await world();
    let sweeps = 0;
    const w = createWatchdog(
      deps(db, clock, {
        freePct: async () => 5,
        requestSweep: () => {
          sweeps += 1;
        },
      }),
    );

    // No useRetention call: the sweep is still asked for, and the tick settles rather than waiting
    // on the sweep's own queue (MEDIUM-1). requestSweep returns void precisely so that
    // awaiting it is not even expressible.
    await w.tick();
    expect(sweeps).toBe(1);
  });
});

describe("stuck processes (§3.1)", () => {
  const drain = async (s: AsyncIterable<Uint8Array>): Promise<void> => {
    // Read to EOF, as ingest and tee do.
    for await (const chunk of s) void chunk;
  };

  async function launched(hold: "both" | "stdout" | "stderr") {
    const { db, clock } = await world();
    const ex = new FakeExecutor({
      clock,
      programs: {
        runner: (io) => {
          io.holdOutput(hold);
          return 0;
        },
      },
    });
    const proc = await ex.exec(["runner"], { cwd: "/", env: {} });
    const stdoutDone = drain(proc.stdout);
    const stderrDone = drain(proc.stderr);
    // As tee builds it: the process's exit and its stderr drained.
    const handle = {
      sessionId: "S",
      executorRef: proc.ref,
      exited: Promise.all([proc.exited, stderrDone]).then(([s]) => s),
    } as unknown as SessionHandle;
    const d = deps(db, clock);
    return { clock, ex, proc, stdoutDone, handle, d, w: createWatchdog(d) };
  }

  test("a descendant holding stdout and stderr: released after the grace, never before, never twice", async () => {
    const x = await launched("both");
    x.d.candidates.track("S", x.ex, x.handle, x.stdoutDone);
    await x.proc.exited;
    await x.w.releaseStuck();
    expect(x.d.candidates.list()).toHaveLength(1);
    await x.clock.advance(GRACE + 1);
    await x.w.releaseStuck();
    await x.stdoutDone;
    await x.handle.exited;
    await x.w.settled();
    expect(x.d.candidates.list()).toHaveLength(0);
  });

  test("stdout only: the exit settles, the candidate stays until EOF, and the release brings it (escape 1)", async () => {
    const x = await launched("stdout");
    x.d.candidates.track("S", x.ex, x.handle, x.stdoutDone);
    await x.handle.exited;
    await x.w.settled();
    expect(x.d.candidates.list()).toHaveLength(1);
    await x.clock.advance(GRACE + 1);
    await x.w.releaseStuck();
    await x.stdoutDone;
    await x.w.settled();
    expect(x.d.candidates.list()).toHaveLength(0);
  });

  test("never attached, stderr held: the handle settles once released (escape 2)", async () => {
    const x = await launched("stderr");
    x.d.candidates.track("S", x.ex, x.handle);
    await x.proc.exited;
    await x.clock.advance(GRACE + 1);
    await x.w.releaseStuck();
    await x.handle.exited;
    await x.w.settled();
    expect(x.d.candidates.list()).toHaveLength(0);
  });

  test("a release that keeps draining is forced after the cap (escape 3)", async () => {
    const { db, clock } = await world();
    const forced: boolean[] = [];
    const stub = {
      exitedAt: () => T0,
      cleanup: async () => undefined,
      releasePipes: (_ref: string, o?: { force?: boolean }): PipeRelease => {
        forced.push(o?.force === true);
        return o?.force === true
          ? { state: "released", pendingBytes: 9 }
          : { state: "draining", pendingBytes: 9 };
      },
    } as unknown as Executor;
    const d = deps(db, clock);
    const handle = {
      sessionId: "D",
      executorRef: "stub:1",
      exited: new Promise(() => undefined),
    } as unknown as SessionHandle;
    d.candidates.track("D", stub, handle);
    const w = createWatchdog(d);
    await clock.advance(GRACE + 1);
    await w.releaseStuck();
    await clock.advance(DRAIN_CAP_GRACES * GRACE - 1);
    await w.releaseStuck();
    await clock.advance(1);
    await w.releaseStuck();
    await w.releaseStuck();
    expect(forced).toEqual([false, false, true]);
  });

  test("the stuck rule runs on its own timer", async () => {
    const x = await launched("both");
    x.d.candidates.track("S", x.ex, x.handle, x.stdoutDone);
    await x.proc.exited;
    x.w.start();
    // The timer re-arms after each op: advance until its op has released the pipes.
    await vi.waitFor(async () => {
      await x.clock.advance(GRACE);
      expect(x.d.candidates.list()).toHaveLength(0);
    });
    await x.stdoutDone;
    await x.w.stop();
  });
});
