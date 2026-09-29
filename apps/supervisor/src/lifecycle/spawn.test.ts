// The spawn pipeline and the FSM edges it drives, on FakeExecutor with the fixture program run
// in-process. Time is a FakeClock; cross-task waits use vi.waitFor deadlines, never a sleep.
import { readFileSync, statSync } from "node:fs";
import {
  FakeClock,
  TEMPLATES,
  compile,
  hashPrompt,
  localTokens,
  ok,
  sha256Hex,
} from "@bayon/core";
import {
  getEventsSince,
  getExecutor,
  getSession,
  listRuns,
  type Db,
} from "@bayon/db";
import { seedRows, tempDb, unwrap, type SeedRows } from "@bayon/db/testing";
import { SlotCounter, type Argv } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  FIXTURE_VERSION,
  fixtureProgram,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import type { StopMode } from "./payloads.js";
import {
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
const HEX = expect.stringMatching(/^[0-9a-f]{64}$/);
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const SCRIPTS = {
  terminal: { runs: [{ events: [TURN] }] },
  gate: { runs: [{ events: [TURN], gate: "release" }] },
} satisfies Record<string, FixtureScriptInput>;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

type Rows = ReturnType<typeof lifecycleRows>;

async function setup(
  o: {
    rows?: RowOptions;
    extra?: (rows: Rows) => SeedRows;
    slots?: number;
    command?: Argv;
    secrets?: Record<string, string>;
  } = {},
) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  // Admission re-reads capacity from the row: the row and the counter agree.
  const rows = lifecycleRows({
    healthArgv: ["ok"],
    ...(o.slots === undefined ? {} : { slots: o.slots }),
    ...o.rows,
  });
  unwrap(await seedRows(t.db, o.extra?.(rows) ?? rows));
  const home = tempHome();
  const slots = new SlotCounter(o.slots ?? 4);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0, fail: () => 1 },
  });
  const adapter = createFixtureAdapter({
    command: o.command ?? [FIXTURE_PROGRAM],
    clock,
  });
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter,
    ...(o.secrets === undefined ? {} : { secrets: o.secrets }),
  });
  cleanups.push(() => {
    started.lifecycle.shutdown();
    t.cleanup();
    home.cleanup();
  });
  const { handlers } = started.lifecycle;
  return {
    ...started,
    db: t.db,
    slots,
    adapter,
    spawn: (id: string, extra: Parameters<typeof spawnPayload>[1] = {}) =>
      handlers.spawn.handle(spawnPayload(id, extra), CMD),
    stop: (id: string, mode: StopMode) =>
      handlers.stop.handle({ session_id: id, mode }, CMD),
    interrupt: (id: string) =>
      handlers.interrupt.handle({ session_id: id }, CMD),
  };
}

const session = async (db: Db, id: string) => unwrap(await getSession(db, id));
const kinds = async (db: Db, id: string) =>
  unwrap(
    await getEventsSince(db, { sessionId: id, since: 0, limit: 1000 }),
  ).rows.map((e) => e.kind);

test("spawn with a prompt: pending → preparing → spawning → idle → running → idle, every hash recorded", async () => {
  const h = await setup({ rows: { script: SCRIPTS.terminal } });
  expect(await h.spawn("S1", { prompt: "do it" })).toEqual(
    ok({ session_id: "S1" }),
  );
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect(unwrap(await listRuns(h.db, "S1"))[0]?.state).toBe("ok");
    expect((await session(h.db, "S1")).state).toBe("idle");
  }, WAIT);
  const s = await session(h.db, "S1");
  expect(s).toMatchObject({
    executor_ref: expect.stringMatching(/^fake:\d+$/),
    runner_session_id: expect.any(String),
    runner_version: FIXTURE_VERSION,
    raw_segment_offset: 0,
    started_at: T0,
    model: "fixture-model",
    model_tier: "standard",
    config_hash: HEX,
    doctrine_hash: HEX,
    toolset_hash: HEX,
    mcp_token_hash: HEX,
    mission_hash: null,
  });
  const [run] = unwrap(await listRuns(h.db, "S1"));
  // Through the operator template; the agent has no mission, and the template no volatile block.
  const prompt = unwrap(compile(TEMPLATES.operator, { task: "do it" }));
  expect(run).toMatchObject({
    seq: 1,
    trigger: "operator",
    idempotency_key: "S1:1",
    template_id: "operator.v1",
    prompt_tokens_est: localTokens(prompt.text),
    truncated_sections_json: "[]",
    prompt_hash: await hashPrompt(prompt.text),
    context_hash: await sha256Hex(""),
    config_hash: s.config_hash,
    doctrine_hash: s.doctrine_hash,
    toolset_hash: s.toolset_hash,
    model: "fixture-model",
    base_sha: null,
  });
  if (run === undefined) throw new Error("no run");
  expect(readFileSync(run.prompt_path, "utf8")).toBe(prompt.text);
  expect(prompt.text).toContain("## Task\ndo it\n");
  expect(statSync(run.prompt_path).mode & 0o777).toBe(0o600);
  expect(statSync(s.home_dir).mode & 0o777).toBe(0o700);
  expect(await kinds(h.db, "S1")).toEqual([
    "session_init",
    "turn_start",
    "terminal",
  ]);
  expect(h.slots.capacity().used).toBe(1); // idle still holds its slot
});

test("session.stop: graceful → resumable (ok), kill → exited (killed); both release the slot", async () => {
  const h = await setup({ rows: { script: SCRIPTS.terminal } });
  const cases = [
    ["G", "graceful", "resumable", "ok"],
    ["K", "kill", "exited", "killed"],
  ] as const;
  for (const [id, mode, state, exitReason] of cases) {
    unwrap(await h.spawn(id));
    await h.lifecycle.settled();
    expect((await session(h.db, id)).state).toBe("idle");
    unwrap(await h.stop(id, mode));
    await h.lifecycle.settled();
    expect(await session(h.db, id)).toMatchObject({
      state,
      exit_reason: exitReason,
      ended_at: T0,
    });
  }
  expect(h.slots.capacity().used).toBe(0);
});

test("a graceful stop of a running session interrupts the run: the runner's terminal wins", async () => {
  const h = await setup({ rows: { script: SCRIPTS.gate } });
  unwrap(await h.spawn("R", { prompt: "wait at the gate" }));
  await vi.waitFor(
    async () => expect(await kinds(h.db, "R")).toContain("turn_start"),
    WAIT,
  );
  unwrap(await h.stop("R", "graceful"));
  await h.lifecycle.settled();
  expect(await session(h.db, "R")).toMatchObject({
    state: "resumable",
    exit_reason: "ok",
  });
  expect(unwrap(await listRuns(h.db, "R"))[0]?.state).toBe("interrupted");
  expect(await kinds(h.db, "R")).toEqual([
    "session_init",
    "turn_start",
    "terminal",
  ]);
});

test("session.interrupt ends the open run and the session goes idle (edge 6)", async () => {
  const h = await setup({ rows: { script: SCRIPTS.gate } });
  unwrap(await h.spawn("I", { prompt: "wait at the gate" }));
  await vi.waitFor(
    async () => expect(await kinds(h.db, "I")).toContain("turn_start"),
    WAIT,
  );
  expect((await session(h.db, "I")).state).toBe("running");
  unwrap(await h.interrupt("I"));
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect((await session(h.db, "I")).state).toBe("idle");
  }, WAIT);
  expect(unwrap(await listRuns(h.db, "I"))[0]?.state).toBe("interrupted");
});

test("behind the slot cap spawns queue `slot`, visibly, first come first served; a stop while queued exits killed", async () => {
  // Three sessions of one agent at once: this test is about the slot, not the agent's concurrency.
  const h = await setup({
    rows: { script: SCRIPTS.terminal, maxConcurrency: 3 },
    slots: 1,
  });
  unwrap(await h.spawn("A"));
  await h.lifecycle.settled();
  unwrap(await h.spawn("B"));
  unwrap(await h.spawn("C"));
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    for (const id of ["B", "C"]) {
      expect(await session(h.db, id)).toMatchObject({
        state: "pending",
        queued_reason: "slot",
      });
    }
  }, WAIT);
  unwrap(await h.stop("C", "graceful"));
  await vi.waitFor(
    async () => expect((await session(h.db, "C")).state).toBe("exited"),
    WAIT,
  );
  expect(await session(h.db, "C")).toMatchObject({
    exit_reason: "killed",
    error_message: "stopped while queued (slot)",
    // Kept on the ended row on purpose: why it never started.
    queued_reason: "slot",
  });
  unwrap(await h.stop("A", "kill"));
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect(await session(h.db, "B")).toMatchObject({
      state: "idle",
      queued_reason: null,
    });
  }, WAIT);
  expect(h.slots.capacity()).toEqual({ slots: 1, used: 1 });
});

test("an unhealthy executor queues the spawn `unhealthy`, visibly, and takes no slot", async () => {
  const h = await setup({
    rows: { script: SCRIPTS.terminal, healthArgv: ["fail"] },
  });
  expect(unwrap(await getExecutor(h.db, EXECUTOR_ID)).health).toBe("unhealthy");
  unwrap(await h.spawn("U"));
  await h.lifecycle.settled();
  expect(await session(h.db, "U")).toMatchObject({
    state: "pending",
    queued_reason: "unhealthy",
  });
  expect(h.slots.capacity().used).toBe(0);
});

test("a runner that cannot start exits spawn_failed and releases its slot", async () => {
  const h = await setup({
    rows: { script: SCRIPTS.terminal },
    command: ["no-such-program"],
  });
  unwrap(await h.spawn("F"));
  await h.lifecycle.settled();
  expect(await session(h.db, "F")).toMatchObject({
    state: "exited",
    exit_reason: "error",
    error_class: "spawn_failed",
  });
  expect(h.slots.capacity().used).toBe(0);
});

test("a secret missing from the store fails the home step (validation); the slot is released", async () => {
  const h = await setup({
    rows: { script: SCRIPTS.terminal },
    extra: (rows) => ({
      ...rows,
      profiles: rows.profiles.map((p) => ({
        ...p,
        secret_refs_json: '["API_KEY"]',
      })),
    }),
  });
  unwrap(await h.spawn("M"));
  await h.lifecycle.settled();
  expect(await session(h.db, "M")).toMatchObject({
    state: "exited",
    error_class: "validation",
    error_message: "secret API_KEY is not in the secret store",
  });
  expect(h.slots.capacity().used).toBe(0);
});

// A runner's one-of rule by name only (Invariant 1): KEY_A or TOKEN_B.
const oneOfRunner = (rows: ReturnType<typeof lifecycleRows>) => ({
  ...rows,
  runners: rows.runners.map((r) => ({
    ...r,
    defaults_json: '{"secretEnvAnyOf":[["KEY_A"],["TOKEN_B"]]}',
  })),
});

test("a runner's one-of secrets: neither fails the home step naming both; either one spawns", async () => {
  const none = await setup({
    rows: { script: SCRIPTS.terminal },
    extra: oneOfRunner,
  });
  unwrap(await none.spawn("N"));
  await none.lifecycle.settled();
  expect(await session(none.db, "N")).toMatchObject({
    state: "exited",
    error_class: "validation",
    error_message: expect.stringContaining(
      "none of the secrets KEY_A | TOKEN_B is in the secret store",
    ),
  });
  expect(none.slots.capacity().used).toBe(0);

  const second = await setup({
    rows: { script: SCRIPTS.terminal },
    extra: oneOfRunner,
    secrets: { FRM_SECRET_TOKEN_B: "b" },
  });
  unwrap(await second.spawn("B"));
  await vi.waitFor(async () => {
    await second.lifecycle.settled();
    expect((await session(second.db, "B")).state).toBe("idle");
  }, WAIT);
});

test("a multi-repo workspace is a validation error in M0", async () => {
  const h = await setup({
    rows: { script: SCRIPTS.terminal },
    extra: (rows) => ({
      ...rows,
      repos: [
        { id: "r1", name: "r1", mirror_path: "/nowhere/r1" },
        { id: "r2", name: "r2", mirror_path: "/nowhere/r2" },
      ],
      workspaces: [{ id: "ws", name: "ws", kind: "multi" }],
      workspace_repos: [
        { workspace_id: "ws", repo_id: "r1", rel_path: "r1" },
        { workspace_id: "ws", repo_id: "r2", rel_path: "r2" },
      ],
    }),
  });
  unwrap(await h.spawn("W", { workspace_id: "ws" }));
  await h.lifecycle.settled();
  expect(await session(h.db, "W")).toMatchObject({
    state: "exited",
    error_class: "validation",
  });
  expect(h.slots.capacity().used).toBe(0);
});

test("resolve failures fail the command and leave no session row", async () => {
  const h = await setup({ rows: { script: SCRIPTS.terminal } });
  expect(await h.spawn("N1", { agent_id: "nobody" })).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(await h.spawn("../escape")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(await h.spawn("N2", { run_class: "no-such-class" })).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  for (const id of ["N1", "N2"]) {
    expect(await getSession(h.db, id)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  }
});

test("a re-delivered session.spawn finds its session and runs nothing twice", async () => {
  const h = await setup({ rows: { script: SCRIPTS.terminal } });
  unwrap(await h.spawn("D", { prompt: "once" }));
  await h.lifecycle.settled();
  expect(await h.spawn("D", { prompt: "once" })).toEqual(
    ok({ session_id: "D" }),
  );
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect((await session(h.db, "D")).state).toBe("idle");
  }, WAIT);
  expect(unwrap(await listRuns(h.db, "D"))).toHaveLength(1);
});
