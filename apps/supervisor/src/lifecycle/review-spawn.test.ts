// The lifecycle's side of a gate's reviewer: run 1's
// SendSpec.output, the session row's gate, afterExit between the process's close and the
// session's end (graceful stop and wall-clock timeout), a profile override, and a reviewer the
// reconciler never adopts.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { FakeClock, TEMPLATES } from "@bayon/core";
import { getSession } from "@bayon/db";
import { createSession, updateSessionState } from "@bayon/db/supervisor";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import type { RunnerAdapter, SendSpec, SpawnSpec } from "@bayon/runners";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  FIXTURE_RUNNER_ID,
  fixtureProgram,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import type { AfterExitFacts } from "./after-exit.js";
import type { InternalSpawn } from "./internal-spawn.js";
import { outputFile, sessionPaths } from "./paths.js";
import {
  AGENT_ID,
  EXECUTOR_ID,
  lifecycleRows,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const WAIT = { timeout: 10_000, interval: 5 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const SHA = "a".repeat(40);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function setup(
  script: FixtureScriptInput = { runs: [{ events: [TURN] }] },
) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const rows = lifecycleRows({ healthArgv: ["ok"], script });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      profiles: [
        ...rows.profiles,
        ...rows.profiles.map((p) => ({
          ...p,
          id: "profile-2",
          name: "profile-2",
        })),
      ],
      tickets: [ticketRow(1)],
      gates: [
        {
          id: "g-1",
          ticket_id: "ticket-1",
          kind: "code_review",
          state: "running",
          attempt: 1,
          subject_kind: "diff",
          subject_ref: "unpinned",
          started_at: T0,
        },
      ],
    }),
  );
  const home = tempHome();
  const slots = new SlotCounter(4);
  const base = createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock });
  const sends: SendSpec[] = [];
  const spawns: SpawnSpec[] = [];
  const adapter: RunnerAdapter = {
    ...base,
    spawn: (spec, ex) => {
      spawns.push(spec);
      return base.spawn(spec, ex);
    },
    send: (h, p) => {
      sends.push(p);
      return base.send(h, p);
    },
  };
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
    adapter,
  });
  // Quiet before the directories go: a spawn still in its pipeline when a test ends (rv-4's) would
  // re-create its session root under the removed home, and leak it.
  cleanups.push(async () => {
    try {
      await started.lifecycle.shutdown();
      await started.lifecycle.settled();
    } finally {
      t.cleanup();
      home.cleanup();
    }
  });
  return {
    clock,
    db: t.db,
    home: home.path,
    lifecycle: started.lifecycle,
    sends,
    spawns,
  };
}

const reviewer = (
  id: string,
  o: Partial<InternalSpawn> = {},
): InternalSpawn => ({
  payload: {
    session_id: id,
    agent_id: AGENT_ID,
    role: "reviewer",
    run_class: "review",
    ticket_id: "ticket-1",
  },
  run: {
    seq: 1,
    trigger: "gate",
    template: TEMPLATES.operator,
    inputs: { task: "review" },
  },
  workspace: "none",
  gate: { id: "g-1", fallbackFrom: null },
  ...o,
});

test("run 1 carries SendSpec.output under the session dir; afterExit runs after the close, before the end", async () => {
  const s = await setup();
  const order: string[] = [];
  const facts: AfterExitFacts[] = [];
  s.lifecycle.onSessionEnded((e) => order.push(`ended:${e.sessionId}`));
  unwrap(
    await s.lifecycle.spawnInternal(
      reviewer("rv-1", {
        gate: { id: "g-1", fallbackFrom: FIXTURE_RUNNER_ID },
        run: {
          seq: 1,
          trigger: "gate",
          template: TEMPLATES.operator,
          inputs: { task: "review" },
          output: { schema: { type: "object" } },
          onEnded: () => void s.lifecycle.stop("rv-1", "graceful"),
        },
        afterExit: async (f) => {
          const state = unwrap(await getSession(s.db, "rv-1")).state;
          order.push(`afterExit:${state}`);
          facts.push(f);
        },
      }),
    ),
  );
  // A graceful stop of a resumable runner suspends it: the session's end, as for a pulse's.
  await vi.waitFor(async () => {
    expect(unwrap(await getSession(s.db, "rv-1")).state).toBe("resumable");
  }, WAIT);
  expect(order).toEqual(["afterExit:stopping", "ended:rv-1"]);
  expect(facts).toHaveLength(1);
  expect(facts[0]?.exit.code).toBe(0);
  expect(facts[0]?.run?.state).toBe("ok");
  expect(facts[0]?.executor.id).toBe(EXECUTOR_ID);
  const path = outputFile(sessionPaths(s.home, "rv-1"), 1);
  expect(s.sends[0]?.output).toEqual({ schema: { type: "object" }, path });
  // The spawn carries run 1's schema too, for a runner that fixes it when its process starts.
  expect(s.spawns[0]?.output).toEqual({ schema: { type: "object" } });
  expect(existsSync(dirname(path))).toBe(true);
  expect(unwrap(await getSession(s.db, "rv-1"))).toMatchObject({
    gate_id: "g-1",
    fallback_from_runner_id: FIXTURE_RUNNER_ID,
    role: "reviewer",
    run_class: "review",
  });
});

test("a run with no output sends none, and spawns with none", async () => {
  const s = await setup();
  unwrap(await s.lifecycle.spawnInternal(reviewer("rv-2")));
  await vi.waitFor(() => expect(s.sends).toHaveLength(1), WAIT);
  expect(s.sends[0]).not.toHaveProperty("output");
  expect(s.spawns).toHaveLength(1);
  expect(s.spawns[0]).not.toHaveProperty("output");
});

test("a wall-clock timeout runs afterExit on the timed-out run, before the session ends", async () => {
  const s = await setup({ runs: [{ events: [TURN], then: "hang" }] });
  const facts: AfterExitFacts[] = [];
  unwrap(
    await s.lifecycle.spawnInternal(
      reviewer("rv-3", {
        run: {
          seq: 1,
          trigger: "gate",
          template: TEMPLATES.operator,
          inputs: { task: "review" },
          wallClockMs: 1_000,
        },
        afterExit: async (f) => {
          expect(unwrap(await getSession(s.db, "rv-3")).state).toBe("stopping");
          facts.push(f);
        },
      }),
    ),
  );
  await vi.waitFor(async () => {
    expect(unwrap(await getSession(s.db, "rv-3")).state).toBe("running");
  }, WAIT);
  await vi.waitFor(async () => {
    await s.clock.advance(1_000);
    expect(facts).toHaveLength(1);
  }, WAIT);
  expect(facts[0]?.run?.state).toBe("timeout");
  await vi.waitFor(async () => {
    expect(unwrap(await getSession(s.db, "rv-3"))).toMatchObject({
      state: "exited",
      exit_reason: "timeout",
    });
  }, WAIT);
});

test("profileId replaces the agent's profile; an unknown one spawns nothing; a short sha is refused", async () => {
  const s = await setup();
  unwrap(
    await s.lifecycle.spawnInternal(
      reviewer("rv-4", { profileId: "profile-2" }),
    ),
  );
  const unknown = await s.lifecycle.spawnInternal(
    reviewer("rv-5", { profileId: "nope" }),
  );
  expect(!unknown.ok && unknown.error.class).toBe("not_found");
  const short = await s.lifecycle.spawnInternal(
    reviewer("rv-6", { workspace: { at: { sha: "abc", baseSha: SHA } } }),
  );
  expect(!short.ok && short.error.class).toBe("validation");
  for (const id of ["rv-5", "rv-6"]) {
    expect((await getSession(s.db, id)).ok).toBe(false);
  }
});

test("the reconciler never adopts a gate's reviewer, even a resumable one (H3)", async () => {
  const s = await setup();
  unwrap(
    await createSession(s.db, {
      id: "orphan-rv",
      agent_id: AGENT_ID,
      role: "reviewer",
      run_class: "review",
      runner_id: FIXTURE_RUNNER_ID,
      executor_id: EXECUTOR_ID,
      session_root: "/tmp/frm-none/work/orphan-rv",
      home_dir: "/tmp/frm-none/home",
      config_hash: "c",
      raw_log_path: "/tmp/frm-none/stdout.jsonl",
      mcp_token_hash: "0".repeat(64),
      runner_session_id: "rs-1",
      gate_id: "g-1",
    }),
  );
  unwrap(
    await updateSessionState(s.db, "orphan-rv", {
      from: ["pending"],
      to: "idle",
    }),
  );
  await s.lifecycle.reconcile();
  // No op of this process ever owned it: the restart's class.
  expect(unwrap(await getSession(s.db, "orphan-rv"))).toMatchObject({
    state: "exited",
    exit_reason: "error",
    error_class: "supervisor_restart",
    error_message: "a reviewer session is never adopted",
  });
});
