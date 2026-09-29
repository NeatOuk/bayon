// Re-admission after a restart, on FakeExecutor rigs, one
// supervisor after another on one database: a queued session is re-admitted behind the adopted
// slot holder with a fresh token, a re-delivered session.spawn short-circuits (exactly one process),
// changed inputs are re-pinned, and what cannot be re-admitted ends through restartAbort.
import { FakeClock, PULSE_RUN_CLASS } from "@bayon/core";
import { getSession, listRuns, type Db } from "@bayon/db";
import { createSession, upsertRegistration } from "@bayon/db/supervisor";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_CAPS,
  FIXTURE_PROGRAM,
  FIXTURE_RUNNER_ID,
  FIXTURE_VERSION,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import {
  AGENT_ID,
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

// Two supervisors, one after the other, per test: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
const WAIT = { timeout: 10_000, interval: 5 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function base() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const rows = lifecycleRows({
    healthArgv: ["ok"],
    script: { runs: [{ events: [TURN] }] },
    slots: 1,
  });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      // Two sessions of one agent at once: S3 holds the executor's one slot while S4 waits on it.
      agents: rows.agents.map((a) => ({ ...a, max_concurrency: 2 })),
    }),
  );
  const home = tempHome();
  cleanups.push(() => {
    t.cleanup();
    home.cleanup();
  });
  return { db: t.db, clock, home: home.path };
}

type Base = Awaited<ReturnType<typeof base>>;

/** A supervisor on the base; `spawned` collects every session id its adapter spawns. */
async function supervisor(b: Base, spawned?: string[]) {
  const slots = new SlotCounter(4); // resized to the row's 1 at boot
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
  });
  const fixture = createFixtureAdapter({
    command: [FIXTURE_PROGRAM],
    clock: b.clock,
  });
  const adapter =
    spawned === undefined
      ? fixture
      : {
          ...fixture,
          spawn: (...args: Parameters<typeof fixture.spawn>) => {
            spawned.push(args[0].sessionId);
            return fixture.spawn(...args);
          },
        };
  const started = await startLifecycle({
    db: b.db,
    clock: b.clock,
    frmHome: b.home,
    executor,
    slots,
    adapter,
  });
  cleanups.unshift(() => started.lifecycle.shutdown());
  return started;
}

type Supervisor = Awaited<ReturnType<typeof supervisor>>;

const session = async (db: Db, id: string) => unwrap(await getSession(db, id));

/** S3 idle on the only slot, S4 queued `slot` behind it; then the supervisor goes away. */
async function queuedAcrossRestart(b: Base) {
  const first = await supervisor(b);
  unwrap(
    await first.lifecycle.handlers.spawn.handle(
      spawnPayload("S3", { prompt: "go" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await first.lifecycle.settled();
    expect((await session(b.db, "S3")).state).toBe("idle");
  }, WAIT);
  unwrap(
    await first.lifecycle.handlers.spawn.handle(
      spawnPayload("S4", { prompt: "go" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    expect((await session(b.db, "S4")).queued_reason).toBe("slot");
  }, WAIT);
  const before = await session(b.db, "S4");
  expect(before.state).toBe("pending");
  expect(JSON.parse(before.spawn_request_json ?? "null")).toMatchObject({
    session_id: "S4",
    prompt: "go",
  });
  await first.lifecycle.shutdown(); // waiters dropped: their rows stay pending
  return before;
}

async function queuedAgain(b: Base, s: Supervisor): Promise<void> {
  await vi.waitFor(async () => {
    await s.lifecycle.settled();
    expect((await session(b.db, "S3")).state).toBe("idle");
    expect(await session(b.db, "S4")).toMatchObject({
      state: "pending",
      queued_reason: "slot",
    });
  }, WAIT);
}

async function admittedOnceTheSlotFrees(b: Base, s: Supervisor): Promise<void> {
  await s.lifecycle.stop("S3", "kill");
  await vi.waitFor(async () => {
    await s.lifecycle.settled();
    expect(unwrap(await listRuns(b.db, "S4"))[0]?.state).toBe("ok");
    expect(await session(b.db, "S4")).toMatchObject({
      state: "idle",
      queued_reason: null,
      spawn_request_json: null,
    });
  }, WAIT);
}

test("a queued session outlives the restart: re-admitted with a new token behind the adopted slot holder, admitted when the slot frees", async () => {
  const b = await base();
  const before = await queuedAcrossRestart(b);
  const next = await supervisor(b);
  await queuedAgain(b, next);
  expect((await session(b.db, "S4")).mcp_token_hash).not.toBe(
    before.mcp_token_hash,
  );
  expect(next.logs.map((l) => l.msg)).toContain("re-admitted after a restart");
  await admittedOnceTheSlotFrees(b, next);
});

test("the requeue/re-admission race ends in exactly one process: the re-delivered session.spawn finds its row", async () => {
  const b = await base();
  await queuedAcrossRestart(b);
  const spawned: string[] = [];
  const next = await supervisor(b, spawned);
  await queuedAgain(b, next);
  // The boot requeue re-delivers S4's claimed session.spawn: attempt 2.
  expect(
    unwrap(
      await next.lifecycle.handlers.spawn.handle(
        spawnPayload("S4", { prompt: "go" }),
        { ...CMD, attempts: 2 },
      ),
    ),
  ).toEqual({ session_id: "S4" });
  await admittedOnceTheSlotFrees(b, next);
  expect(spawned.filter((id) => id === "S4")).toEqual(["S4"]);
});

test("inputs changed while down are re-pinned, not abandoned: the waiter starts on what its row now pins", async () => {
  const b = await base();
  const before = await queuedAcrossRestart(b);
  // The runner's registered defaults change (an adapter upgrade): config_hash changes with them.
  unwrap(
    await upsertRegistration(b.db, {
      runner: {
        id: FIXTURE_RUNNER_ID,
        kind: "script",
        adapter: FIXTURE_RUNNER_ID,
        version_detected: FIXTURE_VERSION,
        caps_json: JSON.stringify(FIXTURE_CAPS),
        defaults_json: '{"mode":"changed"}',
      },
      models: [
        {
          id: `${FIXTURE_RUNNER_ID}.standard`,
          tier: "standard",
          model: "fixture-model",
        },
      ],
    }),
  );
  const next = await supervisor(b);
  // S3 pinned the old config too: unadoptable, it ends, and S4 takes the freed slot at once.
  await vi.waitFor(async () => {
    await next.lifecycle.settled();
    // Unadoptable across the restart: the restart's class.
    expect(await session(b.db, "S3")).toMatchObject({
      state: "exited",
      error_class: "supervisor_restart",
    });
    expect(unwrap(await listRuns(b.db, "S4"))[0]?.state).toBe("ok");
  }, WAIT);
  const after = await session(b.db, "S4");
  expect(after).toMatchObject({ state: "idle", spawn_request_json: null });
  expect(after.config_hash).not.toBe(before.config_hash);
  expect(next.logs.map((l) => l.msg)).toContain(
    "re-admission re-pinned inputs that changed while the supervisor was down",
  );
});

test("a pending row with no request, or a pulse's, is not re-admitted: restartAbort, supervisor_restart", async () => {
  const b = await base();
  const row = (id: string, runClass: string) =>
    createSession(b.db, {
      id,
      agent_id: AGENT_ID,
      role: "builder",
      run_class: runClass,
      runner_id: FIXTURE_RUNNER_ID,
      executor_id: EXECUTOR_ID,
      session_root: `${b.home}/work/${id}`,
      home_dir: `${b.home}/runtime/sessions/${id}/home`,
      config_hash: "0".repeat(64),
      raw_log_path: `${b.home}/runtime/sessions/${id}/logs/stdout.jsonl`,
      mcp_token_hash: `token-hash-${id}`,
      spawn_request_json: JSON.stringify(spawnPayload(id, { prompt: "go" })),
    });
  unwrap(await row("PULSE", PULSE_RUN_CLASS));
  unwrap(
    await createSession(b.db, {
      id: "BARE",
      agent_id: AGENT_ID,
      role: "builder",
      run_class: "build",
      runner_id: FIXTURE_RUNNER_ID,
      executor_id: EXECUTOR_ID,
      session_root: `${b.home}/work/BARE`,
      home_dir: `${b.home}/runtime/sessions/BARE/home`,
      config_hash: "0".repeat(64),
      raw_log_path: `${b.home}/runtime/sessions/BARE/logs/stdout.jsonl`,
      mcp_token_hash: "token-hash-BARE",
    }),
  );
  const s = await supervisor(b);
  await s.lifecycle.settled();
  expect(await session(b.db, "BARE")).toMatchObject({
    state: "exited",
    error_class: "supervisor_restart",
    error_message: "the supervisor restarted during spawn",
  });
  expect(await session(b.db, "PULSE")).toMatchObject({
    state: "exited",
    error_class: "supervisor_restart",
    error_message: "a pulse session is never re-admitted: its pulse settles",
  });
});
