// The run wall-clock timer (§13.2) and "open run = latest run with no terminal" (Invariant 3), on
// FakeExecutor with the in-process fixture. A FakeClock drives time; cross-task waits are deadlines.
import { FakeClock } from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listRuns,
  SUPERVISOR_RUNNER_TYPE,
  type Db,
} from "@bayon/db";
import { finishRun } from "@bayon/db/supervisor";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const WALL = 7_200_000; // run class `build` (§8.4)
const WAIT = { timeout: 10_000, interval: 5 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
type Then = "terminal" | "hang" | "hard_hang" | "exit0";
const script = (then: Then): FixtureScriptInput => ({
  runs: [{ events: [TURN], then }],
});

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

/** A supervisor's in-memory half: its executor, adapter, ingest and lifecycle. */
async function supervisor(db: Db, clock: FakeClock, frmHome: string) {
  const slots = new SlotCounter(4);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
  });
  const adapter = createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock });
  const started = await startLifecycle({
    db,
    clock,
    frmHome,
    executor,
    slots,
    adapter,
  });
  cleanups.push(() => started.lifecycle.shutdown());
  return { ...started, executor, slots };
}

async function setup(then: Then) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(
    await seedRows(
      t.db,
      lifecycleRows({ healthArgv: ["ok"], script: script(then) }),
    ),
  );
  const home = tempHome();
  cleanups.push(() => {
    t.cleanup();
    home.cleanup();
  });
  return {
    ...(await supervisor(t.db, clock, home.path)),
    db: t.db,
    clock,
    home: home.path,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const state = async (db: Db, id: string) =>
  unwrap(await getSession(db, id)).state;
const terminals = async (db: Db, id: string) =>
  unwrap(
    await getEventsSince(db, {
      sessionId: id,
      since: 0,
      kinds: ["terminal"],
      limit: 100,
    }),
  ).rows;
const outcome = (payload: string | null | undefined): unknown =>
  (JSON.parse(payload ?? "{}") as { outcome?: unknown }).outcome;

/** Spawns with a prompt and waits until the runner has started run 1. */
async function running(h: Setup, id: string): Promise<void> {
  unwrap(
    await h.lifecycle.handlers.spawn.handle(
      spawnPayload(id, { prompt: "go" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    const events = unwrap(
      await getEventsSince(h.db, { sessionId: id, since: 0, limit: 10 }),
    );
    expect(events.rows.map((e) => e.kind)).toContain("turn_start");
  }, WAIT);
}

/** Moves fake time in steps until `done`, under a real deadline. */
async function advanceUntil(
  clock: FakeClock,
  done: () => Promise<boolean>,
): Promise<void> {
  await vi.waitFor(async () => {
    if (!(await done())) {
      await clock.advance(1_000);
      throw new Error("not yet");
    }
  }, WAIT);
}

test("hang: past the wall clock the run is timed out and interrupted; the runner's terminal is the only one", async () => {
  const h = await setup("hang");
  await running(h, "H");
  await h.clock.advance(WALL);
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect(await state(h.db, "H")).toBe("exited");
  }, WAIT);
  expect(unwrap(await getSession(h.db, "H"))).toMatchObject({
    exit_reason: "timeout",
    error_class: "timeout",
  });
  expect(unwrap(await listRuns(h.db, "H"))[0]).toMatchObject({
    state: "timeout",
    error_class: "timeout",
  });
  const [only, ...rest] = await terminals(h.db, "H");
  expect(rest).toEqual([]);
  expect(only?.runner_type).toBe("fixture.terminal");
  expect(outcome(only?.payload_json)).toBe("interrupted");
  expect(h.slots.capacity().used).toBe(0);
});

test("hard_hang: no terminal after the interrupt → kill → a supervisor terminal{timeout} at -seq", async () => {
  const h = await setup("hard_hang");
  await running(h, "HH");
  await h.clock.advance(WALL);
  await vi.waitFor(
    async () => expect(await state(h.db, "HH")).toBe("stopping"),
    WAIT,
  );
  await advanceUntil(
    h.clock,
    async () => (await state(h.db, "HH")) === "exited",
  );
  expect(unwrap(await getSession(h.db, "HH")).exit_reason).toBe("timeout");
  expect(unwrap(await listRuns(h.db, "HH"))[0]?.state).toBe("timeout");
  const [only, ...rest] = await terminals(h.db, "HH");
  expect(rest).toEqual([]);
  expect(only).toMatchObject({
    runner_type: SUPERVISOR_RUNNER_TYPE,
    raw_offset: -1,
  });
  expect(outcome(only?.payload_json)).toBe("timeout");
  expect(h.slots.capacity().used).toBe(0);
});

test("a terminal before the deadline cancels the timer", async () => {
  const h = await setup("terminal");
  await running(h, "T");
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect(await state(h.db, "T")).toBe("idle");
  }, WAIT);
  await h.clock.advance(WALL * 2);
  await h.lifecycle.settled();
  expect(await state(h.db, "T")).toBe("idle");
  expect(unwrap(await listRuns(h.db, "T"))[0]?.state).toBe("ok");
  expect(await terminals(h.db, "T")).toHaveLength(1);
});

test("exit0 under a live supervisor: the run fails without terminal, the slot stays held, the next pass adopts", async () => {
  const h = await setup("exit0");
  await running(h, "E");
  const before = unwrap(await getSession(h.db, "E")).executor_ref;
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect(unwrap(await listRuns(h.db, "E"))[0]?.state).toBe("failed");
    expect(await state(h.db, "E")).toBe("idle");
  }, WAIT);
  expect(unwrap(await listRuns(h.db, "E"))[0]?.error_class).toBe(
    "runner_exited_without_terminal",
  );
  const [only] = await terminals(h.db, "E");
  expect(only).toMatchObject({
    runner_type: SUPERVISOR_RUNNER_TYPE,
    raw_offset: -1,
  });
  expect(outcome(only?.payload_json)).toBe("failed");
  expect(h.slots.capacity().used).toBe(1);
  await h.lifecycle.reconcile();
  await h.lifecycle.settled();
  const adopted = unwrap(await getSession(h.db, "E"));
  expect(adopted.state).toBe("idle");
  expect(adopted.executor_ref).not.toBe(before);
  expect(h.slots.capacity().used).toBe(1);
  expect(await terminals(h.db, "E")).toHaveLength(1);
});

test("a crash right after finishRun(timeout) still yields exactly one terminal{timeout} at -seq", async () => {
  const h = await setup("hang");
  await running(h, "C");
  const [run] = unwrap(await listRuns(h.db, "C"));
  if (run === undefined) throw new Error("no run");
  // The first supervisor dies between the timer's verdict and any terminal.
  h.lifecycle.shutdown();
  unwrap(await finishRun(h.db, run.id, { state: "timeout" }));
  const next = await supervisor(h.db, h.clock, h.home);
  await next.lifecycle.settled();
  expect(unwrap(await listRuns(h.db, "C"))[0]?.state).toBe("timeout");
  const [only, ...rest] = await terminals(h.db, "C");
  expect(rest).toEqual([]);
  expect(only).toMatchObject({
    runner_type: SUPERVISOR_RUNNER_TYPE,
    raw_offset: -1,
  });
  expect(outcome(only?.payload_json)).toBe("timeout");
  expect(await state(h.db, "C")).toBe("idle"); // adopted, no auto-resend (amendment 3)
  expect(next.slots.capacity().used).toBe(1);
  // The old process finally ending adds no second terminal.
  const ref = unwrap(await getSession(h.db, "C")).executor_ref;
  await h.executor.cleanup("fake:1", "hard");
  await vi.waitFor(
    async () => expect(await terminals(h.db, "C")).toHaveLength(1),
    WAIT,
  );
  expect(ref).not.toBeNull();
});
