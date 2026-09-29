// Lifecycle.spawnInternal and onSessionEnded: the supervisor's own
// spawns with their own run 1, and what the pulse scheduler hears when a session ends.
import {
  DEFAULT_RUN_CLASSES,
  FakeClock,
  TEMPLATES,
  err,
  ok,
} from "@bayon/core";
import { getSession, listSessionWorktrees } from "@bayon/db";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import type { SessionEnded } from "./context.js";
import type { InternalSpawn } from "./internal-spawn.js";
import {
  AGENT_ID,
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

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** `workspace`: the agent has a workspace (whose mirror does not exist: only "none" may spawn). */
async function setup(
  o: {
    workspace?: boolean;
    /** The agent's max_concurrency; default the column's 1 (admission's real default). */
    maxConcurrency?: number;
  } = {},
) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(
    await seedRows(t.db, {
      ...lifecycleRows({
        healthArgv: ["ok"],
        script: { runs: [{ events: [TURN] }] },
        ...(o.workspace === true ? { workspaceId: "ws" } : {}),
        ...(o.maxConcurrency === undefined
          ? {}
          : { maxConcurrency: o.maxConcurrency }),
      }),
      repos: [{ id: "repo", name: "repo", mirror_path: "/nowhere/mirror" }],
      workspaces: [{ id: "ws", name: "ws", kind: "single" }],
      tickets: [ticketRow(1)],
    }),
  );
  const home = tempHome();
  const slots = new SlotCounter(4);
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor: new FakeExecutor({
      id: EXECUTOR_ID,
      slots,
      programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
    }),
    slots,
    adapter: createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock }),
  });
  // Quiet before the directories go: a spawn still in its pipeline when a test ends would re-create
  // its session root under the removed home, and leak it.
  cleanups.push(async () => {
    try {
      await started.lifecycle.shutdown();
      await started.lifecycle.settled();
    } finally {
      t.cleanup();
      home.cleanup();
    }
  });
  const ended: SessionEnded[] = [];
  started.lifecycle.onSessionEnded((e) => ended.push(e));
  return { clock, db: t.db, lifecycle: started.lifecycle, ended };
}

const spec = (id: string, o: Partial<InternalSpawn> = {}): InternalSpawn => ({
  payload: {
    session_id: id,
    agent_id: AGENT_ID,
    role: "builder",
    run_class: "build",
  },
  run: {
    seq: 1,
    trigger: "operator",
    template: TEMPLATES.operator,
    inputs: { task: "go" },
  },
  workspace: "none",
  ...o,
});

test("workspace none: no worktree even though the agent has a workspace; run 1 is the spec's", async () => {
  const s = await setup({ workspace: true });
  const ended: string[] = [];
  const id = unwrap(
    await s.lifecycle.spawnInternal(
      spec("int-1", {
        run: {
          seq: 1,
          trigger: "orchestrator",
          template: TEMPLATES.operator,
          inputs: { task: "go" },
          onEnded: (run) => ended.push(run.state),
        },
        onCreated: async (sid) => {
          expect(unwrap(await getSession(s.db, sid)).state).toBe("pending");
          return ok(undefined);
        },
      }),
    ),
  );
  await vi.waitFor(async () => {
    await s.lifecycle.settled();
    expect(ended).toEqual(["ok"]);
  }, WAIT);
  expect(unwrap(await getSession(s.db, id)).workspace_id).toBeNull();
  expect(unwrap(await listSessionWorktrees(s.db, id))).toEqual([]);
});

test("refusals spawn nothing: an inherited worktree, a missing tool, a past deadline, an over-budget run", async () => {
  const s = await setup();
  // Twice the seeded build class's context cap at ~4 characters a token, so the prompt is over
  // budget whatever that cap is (raised it from 25k to 300k).
  const buildCap =
    DEFAULT_RUN_CLASSES.find((c) => c.name === "build")?.context_tokens_cap ??
    0;
  const refused = [
    await s.lifecycle.spawnInternal(
      spec("r-1", { workspace: { inherit: { worktreeId: "w" } } }),
    ),
    await s.lifecycle.spawnInternal(
      spec("r-2", { requireTools: ["pulse_report"] }),
    ),
    await s.lifecycle.spawnInternal(spec("r-3", { deadline: T0 })),
    await s.lifecycle.spawnInternal(
      spec("r-4", {
        run: {
          seq: 1,
          trigger: "operator",
          template: TEMPLATES.operator,
          inputs: { task: "x".repeat(8 * buildCap) },
        },
      }),
    ),
  ];
  expect(refused.map((r) => !r.ok && r.error.class)).toEqual([
    "validation",
    "validation",
    "timeout",
    "over_budget",
  ]);
  for (const id of ["r-1", "r-2", "r-3", "r-4"]) {
    expect((await getSession(s.db, id)).ok).toBe(false);
  }
});

// the spawn's own env is validated at resolve, before the pre-flight and the row. It
// used to reach buildEnv, which writes the reserved names last — so a colliding one was silently
// dropped and the session ran on without it.
test("a spawn env the supervisor owns refuses the spawn and writes no session", async () => {
  const s = await setup();
  const refused = await s.lifecycle.spawnInternal(
    spec("env-1", { env: { FRM_SESSION_ID: "forged" } }),
  );
  expect(!refused.ok && refused.error.class).toBe("validation");
  expect(!refused.ok && refused.error.message).toContain("FRM_SESSION_ID");
  expect((await getSession(s.db, "env-1")).ok).toBe(false);
});

// §8.1: two sessions of one profile that work on different things must not record the same input
// hashes. The spawn env is what says what they work on, so it is in config_hash.
test("a spawn env changes the session's config_hash; two pins differ from each other", async () => {
  const s = await setup({ maxConcurrency: 3 });
  const hashOf = async (id: string) =>
    unwrap(await getSession(s.db, id)).config_hash;
  unwrap(await s.lifecycle.spawnInternal(spec("env-2")));
  unwrap(
    await s.lifecycle.spawnInternal(
      spec("env-3", { env: { FRM_PARITY_HEAD: "a".repeat(40) } }),
    ),
  );
  unwrap(
    await s.lifecycle.spawnInternal(
      spec("env-4", { env: { FRM_PARITY_HEAD: "b".repeat(40) } }),
    ),
  );
  expect(await hashOf("env-3")).not.toBe(await hashOf("env-2"));
  expect(await hashOf("env-4")).not.toBe(await hashOf("env-3"));
});

test("onCreated failing aborts the session and returns its error", async () => {
  const s = await setup();
  const failed = await s.lifecycle.spawnInternal(
    spec("oc-1", {
      onCreated: async () =>
        err({ class: "conflict", message: "no link", retryable: false }),
    }),
  );
  expect(!failed.ok && failed.error.class).toBe("conflict");
  expect(unwrap(await getSession(s.db, "oc-1"))).toMatchObject({
    state: "exited",
    error_class: "conflict",
  });
});

test("onSessionEnded tells each end, with the ticket a session held", async () => {
  // Two live sessions of one agent at once: this test is about the end notices, not concurrency.
  const s = await setup({ maxConcurrency: 2 });
  for (const [id, ticket] of [
    ["t-1", "ticket-1"],
    ["n-1", undefined],
  ] as const) {
    unwrap(
      await s.lifecycle.handlers.spawn.handle(
        spawnPayload(id, {
          prompt: "go",
          ...(ticket === undefined ? {} : { ticket_id: ticket }),
        }),
        CMD,
      ),
    );
  }
  await vi.waitFor(async () => {
    await s.lifecycle.settled();
    for (const id of ["t-1", "n-1"]) {
      expect(unwrap(await getSession(s.db, id)).state).toBe("idle");
    }
  }, WAIT);
  await s.lifecycle.stop("t-1", "kill");
  await s.lifecycle.stop("n-1", "kill");
  await s.lifecycle.settled();
  expect(s.ended.map((e) => [e.sessionId, e.ticketId]).toSorted()).toEqual([
    ["n-1", null],
    ["t-1", "ticket-1"],
  ]);
  expect(s.ended.every((e) => e.at === T0)).toBe(true);
  // Each end carries its session's project, as the pulse scheduler's fan-out reads it.
  for (const e of s.ended) {
    expect(e.workspaceId).toBe(
      unwrap(await getSession(s.db, e.sessionId)).workspace_id,
    );
  }
});
