// Reconciler v0 at boot and on its cadence, on FakeExecutor with the in-process fixture: orphans
// from a previous supervisor, the adopt checks, leases, executor health and the 60 s loop.
import { FakeClock } from "@bayon/core";
import {
  getEventsSince,
  getExecutor,
  getSession,
  listRuns,
  listSessionWorktrees,
  SUPERVISOR_RUNNER_TYPE,
  type Db,
} from "@bayon/db";
import {
  appendRun,
  createSession,
  insertWorktree,
  updateSessionState,
  upsertRegistration,
} from "@bayon/db/supervisor";
import {
  newRunInput,
  seedRows,
  tempDb,
  unwrap,
  type SeedRows,
} from "@bayon/db/testing";
import { SlotCounter, type Executor } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_CAPS,
  FIXTURE_PROGRAM,
  FIXTURE_RUNNER_ID,
  FIXTURE_VERSION,
  fixtureProgram,
  type FixtureScriptInput,
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
  type RowOptions,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const WAIT = { timeout: 10_000, interval: 5 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const TERMINAL: FixtureScriptInput = { runs: [{ events: [TURN] }] };
const HASH = "0".repeat(64);

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

const newFake = (slots: SlotCounter) =>
  new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0, fail: () => 1 },
  });

async function base(o: { rows?: RowOptions; extra?: SeedRows } = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const rows = lifecycleRows({
    healthArgv: ["ok"],
    script: TERMINAL,
    ...o.rows,
  });
  unwrap(await seedRows(t.db, { ...rows, ...o.extra }));
  const home = tempHome();
  cleanups.push(() => {
    t.cleanup();
    home.cleanup();
  });
  return { db: t.db, clock, home: home.path };
}

type Base = Awaited<ReturnType<typeof base>>;

async function supervisor(b: Base, executor?: Executor, boot = true) {
  const slots = new SlotCounter(4);
  const started = await startLifecycle({
    db: b.db,
    clock: b.clock,
    frmHome: b.home,
    executor: executor ?? newFake(slots),
    slots,
    adapter: createFixtureAdapter({
      command: [FIXTURE_PROGRAM],
      clock: b.clock,
    }),
    boot,
  });
  cleanups.unshift(() => started.lifecycle.shutdown());
  return { ...started, slots };
}

type Supervisor = Awaited<ReturnType<typeof supervisor>>;

const session = async (db: Db, id: string) => unwrap(await getSession(db, id));

/** Spawns with a prompt and waits for run 1's terminal: the fixture has state to resume from. */
async function idleAfterRun(b: Base, s: Supervisor, id: string) {
  unwrap(
    await s.lifecycle.handlers.spawn.handle(
      spawnPayload(id, { prompt: "go" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await s.lifecycle.settled();
    expect(unwrap(await listRuns(b.db, id))[0]?.state).toBe("ok");
    expect((await session(b.db, id)).state).toBe("idle");
  }, WAIT);
  return session(b.db, id);
}

/** A session row as a previous supervisor left it. */
async function leftover(
  b: Base,
  id: string,
  state: "pending" | "preparing" | "spawning" | "stopping",
) {
  unwrap(
    await createSession(b.db, {
      id,
      agent_id: AGENT_ID,
      role: "builder",
      run_class: "build",
      runner_id: FIXTURE_RUNNER_ID,
      executor_id: EXECUTOR_ID,
      session_root: `${b.home}/work/${id}`,
      home_dir: `${b.home}/runtime/sessions/${id}/home`,
      config_hash: HASH,
      raw_log_path: `${b.home}/runtime/sessions/${id}/logs/stdout.jsonl`,
      mcp_token_hash: `token-hash-${id}`, // unique per session since 003
    }),
  );
  if (state !== "pending") {
    const patch = state === "stopping" ? { executor_ref: "fake:999" } : {};
    unwrap(
      await updateSessionState(b.db, id, {
        from: ["pending"],
        to: state,
        patch,
      }),
    );
  }
}

test("boot ends spawn-state orphans (interrupted) and orphans their worktrees without deleting them", async () => {
  const b = await base({
    extra: {
      repos: [{ id: "repo", name: "repo", mirror_path: "/nowhere/mirror" }],
      workspaces: [{ id: "ws", name: "ws", kind: "single" }],
    },
  });
  for (const [id, state] of [
    ["P", "pending"],
    ["Q", "preparing"],
    ["S", "spawning"],
  ] as const) {
    await leftover(b, id, state);
  }
  unwrap(
    await insertWorktree(b.db, {
      session_root: `${b.home}/work/Q`,
      workspace_id: "ws",
      repo_id: "repo",
      path: `${b.home}/work/Q/repo`,
      branch: "frm/Q",
      base_sha: "abc",
      session_id: "Q",
      state: "active",
    }),
  );
  await supervisor(b);
  for (const id of ["P", "Q", "S"]) {
    expect(await session(b.db, id)).toMatchObject({
      state: "exited",
      exit_reason: "error",
      error_class: "supervisor_restart",
      error_message: "the supervisor restarted during spawn",
    });
  }
  expect(
    unwrap(await listSessionWorktrees(b.db, "Q")).map((w) => w.state),
  ).toEqual(["orphan"]);
});

test("stopping and dead at boot: exited{killed}, its open run closed interrupted at -seq", async () => {
  const b = await base();
  await leftover(b, "X", "stopping");
  const run = unwrap(await appendRun(b.db, newRunInput("X")));
  const s = await supervisor(b);
  await s.lifecycle.settled();
  expect(await session(b.db, "X")).toMatchObject({
    state: "exited",
    exit_reason: "killed",
  });
  expect(unwrap(await listRuns(b.db, "X"))[0]).toMatchObject({
    id: run.id,
    state: "interrupted",
  });
  const events = unwrap(
    await getEventsSince(b.db, { sessionId: "X", since: 0, limit: 10 }),
  ).rows;
  expect(events).toMatchObject([
    { kind: "terminal", runner_type: SUPERVISOR_RUNNER_TYPE, raw_offset: -1 },
  ]);
});

test("an orphan that survives SIGKILL is left for the next pass, then adopted", async () => {
  const b = await base();
  const shared = newFake(new SlotCounter(4));
  const first = await supervisor(b, shared);
  const before = await idleAfterRun(b, first, "O");
  // The next supervisor sees the same process table; its first SIGKILL does nothing.
  let stubborn = true;
  const view: Executor = {
    id: shared.id,
    kind: shared.kind,
    capabilities: shared.capabilities,
    prepare: (spec) => shared.prepare(spec),
    exec: (argv, opts) => shared.exec(argv, opts),
    pty: (argv, opts) => shared.pty(argv, opts),
    probe: (ref) => shared.probe(ref),
    cleanup: async (ref, mode) => {
      if (!stubborn) await shared.cleanup(ref, mode);
    },
    capacity: () => shared.capacity(),
    health: (limits) => shared.health(limits),
  };
  const next = await supervisor(b, view, false);
  const booted = next.lifecycle.boot().then(() => true);
  await vi.waitFor(async () => {
    await b.clock.advance(1_000);
    expect(await Promise.race([booted, Promise.resolve(false)])).toBe(true);
  }, WAIT);
  expect(next.logs.map((l) => l.msg)).toContain(
    "still alive after SIGKILL: next pass",
  );
  expect(await session(b.db, "O")).toMatchObject({
    state: "idle",
    executor_ref: before.executor_ref,
  });
  expect(next.slots.capacity().used).toBe(0);

  stubborn = false;
  await next.lifecycle.reconcile();
  await next.lifecycle.settled();
  const after = await session(b.db, "O");
  expect(after.state).toBe("idle");
  expect(after.executor_ref).not.toBe(before.executor_ref);
  expect(next.slots.capacity().used).toBe(1);
});

test("a config change since spawn makes the dead session unadoptable: exited{error, validation}", async () => {
  const b = await base();
  const executor = newFake(new SlotCounter(4));
  const s = await supervisor(b, executor);
  const before = await idleAfterRun(b, s, "C");
  // The runner's registered defaults change (e.g. an adapter upgrade): config_hash no longer matches.
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
  await executor.cleanup(before.executor_ref ?? "", "hard");
  await vi.waitFor(async () => {
    await s.lifecycle.settled();
    expect(s.logs.map((l) => l.msg)).toContain(
      "the runner exited; the reconciler adopts or ends the session",
    );
  }, WAIT);
  await s.lifecycle.reconcile();
  await s.lifecycle.settled();
  expect(await session(b.db, "C")).toMatchObject({
    state: "exited",
    exit_reason: "error",
    error_class: "validation",
  });
  expect(s.slots.capacity().used).toBe(0);
});

test("a runner session id another live session holds is never adopted twice (Invariant 12)", async () => {
  const b = await base();
  const executor = newFake(new SlotCounter(4));
  const s = await supervisor(b, executor);
  const before = await idleAfterRun(b, s, "A");
  await leftover(b, "Z", "pending");
  unwrap(
    await updateSessionState(b.db, "Z", {
      from: ["pending"],
      to: "awaiting_approval",
      patch: { runner_session_id: before.runner_session_id },
    }),
  );
  await executor.cleanup(before.executor_ref ?? "", "hard");
  await vi.waitFor(async () => {
    await s.lifecycle.settled();
    expect(s.logs.map((l) => l.msg)).toContain(
      "the runner exited; the reconciler adopts or ends the session",
    );
  }, WAIT);
  await s.lifecycle.reconcile();
  await s.lifecycle.settled();
  expect(await session(b.db, "A")).toMatchObject({
    state: "exited",
    error_class: "conflict",
  });
  expect((await session(b.db, "Z")).state).toBe("awaiting_approval"); // never touched
});

test("each pass releases expired leases and checks executor health; passes run every interval", async () => {
  const b = await base({ rows: { healthArgv: ["fail"] } });
  await leftover(b, "L", "pending");
  unwrap(
    await updateSessionState(b.db, "L", {
      from: ["pending"],
      to: "awaiting_approval",
      patch: {
        attach_lease_owner: "operator",
        attach_lease_expires_at: T0 - 1,
      },
    }),
  );
  const s = await supervisor(b);
  expect(await session(b.db, "L")).toMatchObject({
    attach_lease_owner: null,
    attach_lease_expires_at: null,
  });
  expect(unwrap(await getExecutor(b.db, EXECUTOR_ID))).toMatchObject({
    health: "unhealthy",
    health_checked_at: T0,
  });
  const checkedAt = async () =>
    unwrap(await getExecutor(b.db, EXECUTOR_ID)).health_checked_at;
  await b.clock.advance(59_999);
  expect(await checkedAt()).toBe(T0);
  await b.clock.advance(1);
  await vi.waitFor(
    async () => expect(await checkedAt()).toBe(T0 + 60_000),
    WAIT,
  );
  s.lifecycle.shutdown();
  await b.clock.advance(120_000);
  expect(await checkedAt()).toBe(T0 + 60_000); // no pass after shutdown
});

test("an adopt resumes with the session's own model, not today's active one", async () => {
  const b = await base();
  const executor = newFake(new SlotCounter(4));
  const slots = new SlotCounter(4);
  const fixture = createFixtureAdapter({
    command: [FIXTURE_PROGRAM],
    clock: b.clock,
  });
  const adopted: string[] = [];
  const started = await startLifecycle({
    db: b.db,
    clock: b.clock,
    frmHome: b.home,
    executor,
    slots,
    adapter: {
      ...fixture,
      adopt: (...args: Parameters<typeof fixture.adopt>) => {
        adopted.push(args[0].model);
        return fixture.adopt(...args);
      },
    },
  });
  cleanups.unshift(() => started.lifecycle.shutdown());
  const s = { ...started, slots };
  const before = await idleAfterRun(b, s, "M");
  expect(before.model).toBe("fixture-model");
  // A newer standard model is registered; the defaults, and so config_hash, stay the same.
  unwrap(
    await upsertRegistration(b.db, {
      runner: {
        id: FIXTURE_RUNNER_ID,
        kind: "script",
        adapter: FIXTURE_RUNNER_ID,
        version_detected: FIXTURE_VERSION,
        caps_json: JSON.stringify(FIXTURE_CAPS),
        defaults_json: "{}",
      },
      models: [
        {
          id: `${FIXTURE_RUNNER_ID}.standard.v2`,
          tier: "standard",
          model: "fixture-model-2",
        },
      ],
    }),
  );
  await executor.cleanup(before.executor_ref ?? "", "hard");
  await vi.waitFor(async () => {
    await s.lifecycle.settled();
    expect(s.logs.map((l) => l.msg)).toContain(
      "the runner exited; the reconciler adopts or ends the session",
    );
  }, WAIT);
  await s.lifecycle.reconcile();
  await s.lifecycle.settled();
  expect(adopted).toEqual(["fixture-model"]);
  expect(await session(b.db, "M")).toMatchObject({
    state: "idle",
    model: "fixture-model",
  });
});
