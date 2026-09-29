// The session FSM (design §2, test plan §8). The edge table is §2's; every edge fired
// from outside its from-set is a `conflict` that changes nothing; and a stop racing a run's
// terminal ends right both ways, on FakeExecutor with the in-process fixture. A FakeClock drives
// time; cross-task waits are deadlines, never a sleep.
import { FakeClock, SessionState } from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listRuns,
  SUPERVISOR_RUNNER_TYPE,
  type Db,
} from "@bayon/db";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { pino } from "pino";
import { afterAll, describe, expect, test, vi } from "vitest";
import { createIngest } from "../ingest/ingest.js";
import type { Ctx } from "./context.js";
import { endSession } from "./end.js";
import { EDGES, fire, type Edge, type EdgeName, type EndEdge } from "./fsm.js";
import { createAdmission } from "./admission.js";
import type { StopMode } from "./payloads.js";
import type { Ingest, TerminalNotice } from "./ports.js";
import { envSecrets } from "./secrets.js";
import { KeyedQueue } from "./session-queue.js";
import { ReleaseCandidates } from "../watchdog/candidates.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const WAIT = { timeout: 10_000, interval: 5 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const SCRIPTS = {
  /** Run 1 stays open until released or interrupted. */
  gate: { runs: [{ events: [TURN], gate: "release" }] },
  /** Run 1 ends at once. */
  terminal: { runs: [{ events: [TURN] }] },
} satisfies Record<string, FixtureScriptInput>;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/**
 * Ingest whose terminal notices wait until `deliver()`: the terminal has committed (the run has
 * its verdict) but its edge 6 has not been tried yet, as when a stop op is ahead of it.
 */
function holdingTerminals(inner: Ingest) {
  const listeners = new Set<(t: TerminalNotice) => void>();
  const held: TerminalNotice[] = [];
  const unsubscribe = inner.onTerminal((t) => {
    held.push(t);
  });
  const ingest: Ingest = {
    ...inner,
    onTerminal: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const deliver = (): void => {
    for (const t of held.splice(0)) for (const fn of listeners) fn(t);
  };
  return { ingest, held, deliver, unsubscribe };
}

async function setup(script: FixtureScriptInput) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedRows(t.db, lifecycleRows({ healthArgv: ["ok"], script })));
  const home = tempHome("frm-fix-sup-");
  const slots = new SlotCounter(4);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
  });
  const inner = createIngest({
    db: t.db,
    clock,
    log: pino({ level: "silent" }),
    maxRows: 1,
  });
  const terminals = holdingTerminals(inner);
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock }),
    ingest: terminals.ingest,
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    terminals.unsubscribe();
    await inner.shutdown();
    t.cleanup();
    home.cleanup();
  });
  const { handlers } = started.lifecycle;
  return {
    ...started,
    db: t.db,
    slots,
    terminals,
    spawn: (id: string, prompt: string) =>
      handlers.spawn.handle(spawnPayload(id, { prompt }), CMD),
    stop: (id: string, mode: StopMode) =>
      handlers.stop.handle({ session_id: id, mode }, CMD),
  };
}

const session = async (db: Db, id: string) => unwrap(await getSession(db, id));
const terminalsOf = async (db: Db, id: string) =>
  unwrap(
    await getEventsSince(db, {
      sessionId: id,
      since: 0,
      kinds: ["terminal"],
      limit: 100,
    }),
  ).rows;
const kinds = async (db: Db, id: string) =>
  unwrap(
    await getEventsSince(db, { sessionId: id, since: 0, limit: 100 }),
  ).rows.map((e) => e.kind);
const outcome = (payload: string | null | undefined): unknown =>
  (JSON.parse(payload ?? "{}") as { outcome?: unknown }).outcome;

// --- The edge table ----------------------------------------------------------------------------

/** Design §2, transcribed: #, from-set, to. Edge 1 (∅ → pending) is the insert, not a move. */
const DESIGN_2 = [
  [2, ["pending"], "preparing"],
  [3, ["preparing"], "spawning"],
  [4, ["spawning"], "idle"],
  [5, ["idle"], "running"],
  [6, ["running"], "idle"],
  [7, ["running", "idle", "handoff_writing"], "stopping"],
  [8, ["stopping"], "exited"],
  [9, ["stopping"], "resumable"],
  [10, ["running", "idle"], "idle"],
  [11, ["running", "idle", "handoff_writing"], "exited"],
  [12, ["pending", "preparing", "spawning"], "exited"],
  [13, ["stopping"], "exited"],
  // the hand-off edges (design §2).
  [14, ["running", "idle"], "handoff_writing"],
  [15, ["handoff_writing"], "handed_off"],
  [16, ["handoff_writing"], "exited"],
  // admission records a queued session's reason; its state stays pending.
  [17, ["pending"], "pending"],
  // an earlier change §3.1: the reconciler's restartAbort, hooked unlike edge 12.
  [18, ["pending", "preparing", "spawning"], "exited"],
  // §12.5: the operator's attach lease.
  [19, ["running", "idle"], "human_attached"],
  [20, ["human_attached"], "idle"],
  // the operator gives up on resuming a suspended session, the one edge out of it.
  [21, ["resumable"], "exited"],
];
const EDGE_NAMES = Object.keys(EDGES).filter((k): k is EdgeName => k in EDGES);
const edgeOf = (name: EdgeName): Edge => EDGES[name];
const END_EDGES: readonly EndEdge[] = [
  "exit",
  "suspend",
  "die",
  "abort",
  "reap",
  "handOff",
  "handoffFail",
  "restartAbort",
  "discard",
];
/** Columns a patch may set: a conflict must leave every one as it was. */
const PATCH = {
  executor_ref: "fake:999",
  error_message: "must not land",
  ended_at: T0 + 1,
} as const;

/** The spine (seedSpine) plus one session per [id, state], and a Ctx over them. */
async function edgeDb(sessions: readonly (readonly [string, SessionState])[]) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedSpine(t.db, 1));
  const rows = sessions.map(([id, state]) => ({
    ...newSessionInput(),
    id,
    state,
    created_at: T0,
  }));
  unwrap(await seedRows(t.db, { sessions: rows }));
  const log = pino({ level: "silent" });
  const ingest = createIngest({ db: t.db, clock, log });
  cleanups.push(async () => {
    await ingest.shutdown();
    t.cleanup();
  });
  const ctx: Ctx = {
    db: t.db,
    clock,
    log,
    frmHome: "/nonexistent",
    executors: new Map(),
    adapters: new Map(),
    ingest,
    secrets: envSecrets({}),
    settings: DEFAULT_SETTINGS,
    path: "/usr/bin:/bin",
    mcpUrl: "http://127.0.0.1:9/mcp",
    mcpReachable: async () => true,
    live: new Map(),
    queue: new KeyedQueue(),
    mirrors: new KeyedQueue(),
    adopts: new Map(),
    ended: new Set(),
    pending: new Set(),
    afterExit: new Map(),
    homeTag: "fh-000000000000000000000000",
    orphanScan: new Map(),
    jobRunners: new Set(),
    // No spawn here: the drain never admits, so its pipeline start is never called.
    admission: createAdmission(
      () => ctx,
      () => undefined,
    ),
    owned: new Set(),
    candidates: new ReleaseCandidates(),
    ptyChannels: new Map(),
  };
  return { db: t.db, ctx };
}

describe("the edge table", () => {
  test("is design §2's, and no from-set holds an M1 state or one without a process", () => {
    expect(
      EDGE_NAMES.map((name) => {
        const e = edgeOf(name);
        return [e.n, e.from, e.to];
      }),
    ).toEqual(DESIGN_2);
    // handoff_writing has a process: stop, die and the seal edges leave it.
    // human_attached is no longer reserved (§12.5): attach/release are its only edges.
    const never: readonly SessionState[] = [
      "awaiting_approval",
      "handed_off",
      "exited",
      "resumable",
    ];
    // `discard` is the one deliberate exception: resumability being protected by
    // having no edge out of it was exactly the dead end, so the operator gets one decisive edge
    // and nothing else does. Every other edge still obeys the rule.
    const held = EDGE_NAMES.filter((name) => name !== "discard").flatMap(
      (name) => edgeOf(name).from.filter((s) => never.includes(s)),
    );
    expect(held).toEqual([]);
    expect(edgeOf("discard").from).toEqual(["resumable"]);
    const ending = EDGE_NAMES.filter((name) =>
      ["exited", "resumable", "handed_off"].includes(edgeOf(name).to),
    );
    expect(ending).toEqual(END_EDGES);
    // A death in handoff_writing is never adopted: it gets its degraded packet.
    expect(edgeOf("adopt").from).not.toContain("handoff_writing");
  });

  test("every edge fired from outside its from-set is a conflict and leaves the row unchanged", async () => {
    const { db } = await edgeDb(
      SessionState.options.map((s) => [`S-${s}`, s] as const),
    );
    let fired = 0;
    for (const name of EDGE_NAMES) {
      const outside = SessionState.options.filter(
        (s) => !edgeOf(name).from.includes(s),
      );
      for (const state of outside) {
        const id = `S-${state}`;
        const before = await session(db, id);
        const result = await fire(db, id, name, PATCH);
        expect({
          name,
          state,
          result: result.ok ? "moved" : result.error.class,
        }).toEqual({ name, state, result: "conflict" });
        expect(await session(db, id)).toEqual(before);
        fired += 1;
      }
    }
    const inside = EDGE_NAMES.reduce((n, e) => n + edgeOf(e).from.length, 0);
    expect(fired).toBe(
      EDGE_NAMES.length * SessionState.options.length - inside,
    );
  });

  test("every edge fired from inside its from-set moves the session and applies its patch", async () => {
    const cases = EDGE_NAMES.flatMap((name) =>
      edgeOf(name).from.map((state) => ({
        name,
        state,
        id: `${name}-${state}`,
      })),
    );
    const { db } = await edgeDb(cases.map((c) => [c.id, c.state] as const));
    for (const c of cases) {
      const result = await fire(db, c.id, c.name, PATCH);
      expect(
        result.ok
          ? { state: result.value.state, ref: result.value.executor_ref }
          : result.error,
      ).toEqual({ state: edgeOf(c.name).to, ref: PATCH.executor_ref });
    }
  });

  test("an end edge that conflicts leaves the entry and its slot alone; one that commits lets go", async () => {
    // Each end edge from a state outside its from-set.
    const outside = (name: EndEdge): SessionState =>
      edgeOf(name).from.includes("running") ? "stopping" : "running";
    const ids = END_EDGES.map((name) => [`E-${name}`, outside(name)] as const);
    const { db, ctx } = await edgeDb([...ids, ["E-commit", "stopping"]]);
    const slots = new SlotCounter(END_EDGES.length + 1);
    const hold = async (id: string): Promise<void> => {
      const slot = slots.tryAcquire();
      if (slot === null) throw new Error("the test sized its slots too small");
      ctx.live.set(id, { abort: new AbortController(), dead: false, slot });
    };
    for (const [id] of ids) await hold(id);

    for (const name of END_EDGES) {
      const id = `E-${name}`;
      const before = await session(db, id);
      await endSession(ctx, id, name, { exit_reason: "killed" });
      expect(await session(db, id)).toEqual(before);
      expect({ name, owned: ctx.live.has(id) }).toEqual({ name, owned: true });
    }
    expect(slots.capacity().used).toBe(END_EDGES.length);

    await hold("E-commit");
    await endSession(ctx, "E-commit", "exit", { exit_reason: "killed" });
    expect(await session(db, "E-commit")).toMatchObject({
      state: "exited",
      exit_reason: "killed",
      ended_at: T0,
    });
    expect(ctx.live.has("E-commit")).toBe(false);
    expect(slots.capacity().used).toBe(END_EDGES.length);
  });
});

// --- Stop versus terminal ----------------------------------------------------------------------

/** Where each stop mode ends a session (edges 8, 9). */
const ENDED = {
  graceful: { state: "resumable", exit_reason: "ok", ended_at: T0 },
  kill: { state: "exited", exit_reason: "killed", ended_at: T0 },
} as const;

describe.each(["graceful", "kill"] as const)(
  "stop (%s) versus terminal",
  (mode) => {
    test("the stop lands first: edge 7 wins, the terminal's edge 6 conflicts, one terminal", async () => {
      const h = await setup(SCRIPTS.gate);
      unwrap(await h.spawn("A", "wait at the gate"));
      await vi.waitFor(
        async () => expect(await kinds(h.db, "A")).toContain("turn_start"),
        WAIT,
      );
      expect((await session(h.db, "A")).state).toBe("running");

      unwrap(await h.stop("A", mode));
      await vi.waitFor(async () => {
        await h.lifecycle.settled();
        expect(h.terminals.held).toHaveLength(1);
      }, WAIT);
      const ended = await session(h.db, "A");
      expect(ended).toMatchObject(ENDED[mode]);

      h.terminals.deliver(); // edge 6, from `running` only: a conflict now
      await h.lifecycle.settled();
      expect(await session(h.db, "A")).toEqual(ended);
      expect(unwrap(await listRuns(h.db, "A"))[0]?.state).toBe("interrupted");
      const [only, ...rest] = await terminalsOf(h.db, "A");
      expect(rest).toEqual([]);
      expect(outcome(only?.payload_json)).toBe("interrupted");
      // graceful: the runner answers the interrupt; kill: it never can, so ingest writes one at -seq.
      expect(only).toMatchObject(
        mode === "graceful"
          ? { runner_type: "fixture.terminal" }
          : { runner_type: SUPERVISOR_RUNNER_TYPE, raw_offset: -1 },
      );
      expect(h.slots.capacity().used).toBe(0);
    });

    test("the terminal lands first: the stop takes edge 7 over a finished run and adds no terminal", async () => {
      const h = await setup(SCRIPTS.terminal);
      unwrap(await h.spawn("B", "finish at once"));
      await vi.waitFor(async () => {
        await h.lifecycle.settled();
        expect(h.terminals.held).toHaveLength(1);
      }, WAIT);
      // The terminal has committed and the run has its verdict; its edge 6 is still to come.
      expect((await session(h.db, "B")).state).toBe("running");
      expect(unwrap(await listRuns(h.db, "B"))[0]?.state).toBe("ok");

      unwrap(await h.stop("B", mode));
      await h.lifecycle.settled();
      const ended = await session(h.db, "B");
      expect(ended).toMatchObject(ENDED[mode]);

      h.terminals.deliver();
      await h.lifecycle.settled();
      expect(await session(h.db, "B")).toEqual(ended);
      expect(unwrap(await listRuns(h.db, "B"))[0]?.state).toBe("ok");
      const [only, ...rest] = await terminalsOf(h.db, "B");
      expect(rest).toEqual([]);
      expect(only?.runner_type).toBe("fixture.terminal");
      expect(outcome(only?.payload_json)).toBe("ok");
      expect(h.slots.capacity().used).toBe(0);
    });

    test("the terminal lands first and its edge 6 runs first: idle, then the stop, one terminal", async () => {
      const h = await setup(SCRIPTS.terminal);
      unwrap(await h.spawn("C", "finish at once"));
      await vi.waitFor(async () => {
        await h.lifecycle.settled();
        expect(h.terminals.held).toHaveLength(1);
      }, WAIT);
      h.terminals.deliver();
      await h.lifecycle.settled();
      expect((await session(h.db, "C")).state).toBe("idle");

      unwrap(await h.stop("C", mode));
      await h.lifecycle.settled();
      expect(await session(h.db, "C")).toMatchObject(ENDED[mode]);
      const [only, ...rest] = await terminalsOf(h.db, "C");
      expect(rest).toEqual([]);
      expect(outcome(only?.payload_json)).toBe("ok");
      expect(h.slots.capacity().used).toBe(0);
    });
  },
);
