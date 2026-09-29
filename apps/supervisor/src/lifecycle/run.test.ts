// Run n (§8.2): startRun opens run <seq> on a live idle session. The prompt is compiled through a
// template, held to its cap, written to prompts/run-<n>.md, and the run records its template,
// estimate, cuts and pinned hashes. FakeExecutor with the fixture program in-process, a FakeClock.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FakeClock,
  TEMPLATES,
  compile,
  err,
  localTokens,
  promptHashes,
  templateRecord,
} from "@bayon/core";
import {
  getEventsSince,
  getPromptTemplate,
  getSession,
  listPairFailuresSince,
  listRuns,
  type RunRow,
} from "@bayon/db";
import { updateSessionState } from "@bayon/db/supervisor";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import type { RunnerAdapter } from "@bayon/runners";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { createIngest } from "../ingest/ingest.js";
import { sessionPaths } from "./paths.js";
import type { RunRequest } from "./prompt.js";
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
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const SCRIPTS = {
  twoRuns: { runs: [{ events: [TURN] }, { events: [TURN] }] },
  gate: { runs: [{ events: [TURN], gate: "release" }] },
  gateSecond: {
    runs: [{ events: [TURN] }, { events: [TURN], gate: "release" }],
  },
} satisfies Record<string, FixtureScriptInput>;

/** A run class with a small context cap, for the over-budget cases. */
const TINY = {
  name: "tiny",
  context_tokens_cap: 200,
  max_turns: 10,
  max_tool_calls: 10,
  wall_clock_ms: 600_000,
  cost_cap_usd: 1,
  handoff_at_turns: 0,
  default_tier: "standard" as const,
};

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

async function setup(o: RowOptions = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const rows = lifecycleRows({
    healthArgv: ["ok"],
    script: SCRIPTS.twoRuns,
    ...o,
  });
  unwrap(await seedRows(t.db, { ...rows, run_classes: [TINY] }));
  const home = tempHome();
  const slots = new SlotCounter(4);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
  });
  const fixture = createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock });
  /**
   * `failSend`: the adapter refuses every send, as a runner refusing a prompt would. `failOpen`:
   * ingest's openRun refuses, as a busy database would: a step of the supervisor's own.
   */
  const control: {
    failSend: boolean;
    failOpen: boolean;
    /** Once: the session this names leaves idle during the prompt's token estimate, so run.ts's
     * startRun move itself fails (a step of the supervisor's own). */
    flipOnEstimate: string | null;
  } = { failSend: false, failOpen: false, flipOnEstimate: null };
  // Every record commits at once, as the harness's own ingest does.
  const real = createIngest({
    db: t.db,
    clock,
    log: pino({ level: "silent" }),
    maxRows: 1,
  });
  const ingest = {
    ...real,
    openRun: (sessionId: string, runId: string) =>
      control.failOpen
        ? Promise.resolve(
            err({
              class: "db_busy",
              message: "database is locked",
              retryable: true,
            }),
          )
        : real.openRun(sessionId, runId),
  };
  const adapter: RunnerAdapter = {
    ...fixture,
    // The estimate runs only for a runner that counts tokens: on while a flip is armed.
    caps: () => ({
      ...fixture.caps(),
      tokenCounting:
        control.flipOnEstimate !== null || fixture.caps().tokenCounting,
    }),
    estimateTokens: async (text) => {
      const flip = control.flipOnEstimate;
      if (flip !== null) {
        control.flipOnEstimate = null;
        unwrap(
          await updateSessionState(t.db, flip, {
            from: ["idle"],
            to: "stopping",
          }),
        );
      }
      return fixture.estimateTokens(text);
    },
    send: (handle, p) =>
      control.failSend
        ? Promise.resolve(
            err({
              class: "runner_error",
              message: "send refused",
              retryable: false,
            }),
          )
        : fixture.send(handle, p),
  };
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter,
    ingest,
  });
  cleanups.push(() => {
    started.lifecycle.shutdown();
    void real.shutdown();
    t.cleanup();
    home.cleanup();
  });
  const { lifecycle } = started;
  return {
    ...started,
    db: t.db,
    clock,
    control,
    runnerId: adapter.id,
    slots,
    frmHome: home.path,
    spawn: (id: string, extra: Parameters<typeof spawnPayload>[1] = {}) =>
      lifecycle.handlers.spawn.handle(spawnPayload(id, extra), CMD),
    /** Waits until the session's `n` runs ended ok and it is idle again. */
    idle: (id: string, n: number) =>
      vi.waitFor(async () => {
        await lifecycle.settled();
        const states = unwrap(await listRuns(t.db, id)).map((r) => r.state);
        expect(states).toEqual(Array.from({ length: n }, () => "ok"));
        expect(unwrap(await getSession(t.db, id)).state).toBe("idle");
      }, WAIT),
  };
}

const operator = (seq: number, task = "again"): RunRequest => ({
  seq,
  trigger: "retry",
  template: TEMPLATES.operator,
  inputs: { task },
});

test("boot upserts every template into prompt_templates", async () => {
  const h = await setup();
  for (const template of Object.values(TEMPLATES)) {
    const record = await templateRecord(template);
    expect(unwrap(await getPromptTemplate(h.db, record.id))).toEqual({
      ...record,
      created_at: T0,
    });
  }
});

test("run 2 on an idle session: the next seq, its idempotency key, the template and every pinned hash", async () => {
  const h = await setup();
  unwrap(await h.spawn("S", { prompt: "first" }));
  await h.idle("S", 1);
  const inputs = {
    ticket: "Build the thing.",
    current_step: { step: 2, of: 3 },
  };
  const req: RunRequest = {
    seq: 2,
    trigger: "orchestrator",
    template: TEMPLATES.build,
    inputs,
  };
  const opened = unwrap(await h.lifecycle.startRun("S", req));
  await h.idle("S", 2);
  const [run1, run2] = unwrap(await listRuns(h.db, "S"));
  if (run1 === undefined || run2 === undefined) throw new Error("no runs");
  const prompt = unwrap(compile(TEMPLATES.build, inputs));
  const hashes = await promptHashes(prompt);
  expect(run2).toMatchObject({
    id: opened.id,
    seq: 2,
    trigger: "orchestrator",
    idempotency_key: "S:2",
    template_id: "build.v8",
    prompt_path: join(sessionPaths(h.frmHome, "S").prompts, "run-2.md"),
    prompt_tokens_est: localTokens(prompt.text),
    truncated_sections_json: "[]",
    ...hashes,
    mission_hash: run1.mission_hash,
    doctrine_hash: run1.doctrine_hash,
    toolset_hash: run1.toolset_hash,
    config_hash: run1.config_hash,
    model: run1.model,
    effort: run1.effort,
    base_sha: null,
    state: "ok",
  });
  // The volatile block is what context_hash covers: run 1 (operator) had none.
  expect(run2.context_hash).not.toBe(run1.context_hash);
  expect(readFileSync(run2.prompt_path, "utf8")).toBe(prompt.text);
});

test("a taken seq is a conflict, a skipped one or a bad input a validation error; none opens a run", async () => {
  const h = await setup();
  unwrap(await h.spawn("S", { prompt: "first" }));
  await h.idle("S", 1);
  expect(await h.lifecycle.startRun("S", operator(1))).toMatchObject({
    ok: false,
    error: { class: "conflict", message: "session S already has run 1" },
  });
  expect(await h.lifecycle.startRun("S", operator(3))).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: "run 3 is not next: session S is at run 1",
    },
  });
  const bogus = { ...operator(2), inputs: { bogus: "x", task: "t" } };
  expect(await h.lifecycle.startRun("S", bogus)).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: "prompt operator.v1 has no section bogus",
    },
  });
  expect(unwrap(await listRuns(h.db, "S"))).toHaveLength(1);
});

test("over its cap, run n is refused with over_budget and the section sizes: no run, no prompt file", async () => {
  const h = await setup();
  unwrap(await h.spawn("S", { prompt: "first", run_class: "tiny" }));
  await h.idle("S", 1);
  // review's change is never cut, so 2,000 characters cannot fit the tiny class's 200 tokens.
  const review: RunRequest = {
    seq: 2,
    trigger: "gate",
    template: TEMPLATES.review,
    inputs: { ticket: "t", change: "x".repeat(2_000) },
  };
  expect(await h.lifecycle.startRun("S", review)).toMatchObject({
    ok: false,
    error: {
      class: "over_budget",
      message: expect.stringMatching(
        /^prompt review\.v2 is over the tiny budget: \d+ tokens \(\d+ \+ 15 % margin\) > cap 200; sections, in local tokens: template \d+, ticket \d+, change 506$/,
      ),
      cause: { template_id: "review.v2", run_class: "tiny", cap_tokens: 200 },
    },
  });
  // A cap of its own (a hand-off request's, say) overrides the run class's.
  expect(
    await h.lifecycle.startRun("S", { ...operator(2), capTokens: 10 }),
  ).toMatchObject({
    ok: false,
    error: {
      class: "over_budget",
      message: expect.stringContaining("> cap 10;"),
    },
  });
  expect(unwrap(await listRuns(h.db, "S"))).toHaveLength(1);
  expect(
    existsSync(join(sessionPaths(h.frmHome, "S").prompts, "run-2.md")),
  ).toBe(false);
  expect(unwrap(await getSession(h.db, "S")).state).toBe("idle");
  expect(h.logs.filter((l) => l.msg === "run 2 not started")).toHaveLength(2);
});

test("preflight.margin_pct comes from settings: migration 004 seeds 15, a row overrides it", async () => {
  const cap = localTokens(
    unwrap(compile(TEMPLATES.operator, { task: "again" })).text,
  );
  for (const [settings, expected] of [
    [{}, false],
    [{ "preflight.margin_pct": 0 }, true],
  ] as const) {
    const h = await setup({ settings });
    unwrap(await h.spawn("S", { prompt: "first" }));
    await h.idle("S", 1);
    const r = await h.lifecycle.startRun("S", {
      ...operator(2),
      capTokens: cap,
    });
    expect(r.ok).toBe(expected);
  }
});

test("a spawn whose prompt is over its run class cap fails the command, and nothing is spawned", async () => {
  const h = await setup();
  expect(
    await h.spawn("B", { run_class: "tiny", prompt: "x".repeat(4_000) }),
  ).toMatchObject({
    ok: false,
    error: {
      class: "over_budget",
      message: expect.stringContaining(
        "prompt operator.v1 is over the tiny budget",
      ),
    },
  });
  expect(await getSession(h.db, "B")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("a session that is not idle, or has no live process, gets no run", async () => {
  const h = await setup({ script: SCRIPTS.gate });
  unwrap(await h.spawn("G", { prompt: "wait at the gate" }));
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect(unwrap(await getSession(h.db, "G")).state).toBe("running");
  }, WAIT);
  expect(await h.lifecycle.startRun("G", operator(2))).toMatchObject({
    ok: false,
    error: { class: "conflict", message: "session G is running, not idle" },
  });
  expect(await h.lifecycle.startRun("nope", operator(1))).toMatchObject({
    ok: false,
    error: { class: "conflict", message: "session nope has no live process" },
  });
  expect(unwrap(await listRuns(h.db, "G"))).toHaveLength(1);
});

// hand-off request runs inside handoff_writing, and its code owns the way out.
const handoff = (seq: number): RunRequest => ({
  seq,
  trigger: "handoff",
  template: TEMPLATES.handoff_request,
  inputs: { reason: "turn_ceiling" },
  within: "handoff_writing",
});
/** Stands in for edge into handoff_writing. */
const toHandoffWriting = {
  from: ["idle" as const],
  to: "handoff_writing" as const,
};

test("a run starts only in its `within` state, and one inside handoff_writing leaves the session there", async () => {
  const h = await setup();
  unwrap(await h.spawn("S", { prompt: "first" }));
  await h.idle("S", 1);
  expect(await h.lifecycle.startRun("S", handoff(2))).toMatchObject({
    ok: false,
    error: {
      class: "conflict",
      message: "session S is idle, not handoff_writing",
    },
  });
  unwrap(await updateSessionState(h.db, "S", toHandoffWriting));
  expect(await h.lifecycle.startRun("S", operator(2))).toMatchObject({
    ok: false,
    error: {
      class: "conflict",
      message: "session S is handoff_writing, not idle",
    },
  });
  const ended: RunRow[] = [];
  const run = unwrap(
    await h.lifecycle.startRun("S", {
      ...handoff(2),
      onEnded: (r) => ended.push(r),
    }),
  );
  expect(run).toMatchObject({
    seq: 2,
    trigger: "handoff",
    template_id: "handoff_request.v2",
  });
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    const states = unwrap(await listRuns(h.db, "S")).map((r) => r.state);
    expect(states).toEqual(["ok", "ok"]);
  }, WAIT);
  // Edge 5 from handoff_writing would have failed the run; its end did not move the session.
  expect(unwrap(await getSession(h.db, "S")).state).toBe("handoff_writing");
  expect(ended.map((r) => [r.id, r.state])).toEqual([[run.id, "ok"]]);
});

test("a run inside handoff_writing past its wall clock: timed out, process torn down, slot released, state left", async () => {
  const h = await setup({ script: SCRIPTS.gateSecond });
  unwrap(await h.spawn("S", { prompt: "first" }));
  await h.idle("S", 1);
  unwrap(await updateSessionState(h.db, "S", toHandoffWriting));
  const ended: RunRow[] = [];
  const req: RunRequest = {
    ...handoff(2),
    wallClockMs: 1_000,
    onEnded: (r) => ended.push(r),
  };
  unwrap(await h.lifecycle.startRun("S", req));
  expect(h.slots.capacity().used).toBe(1);
  // Past the wall clock, then on through the interrupt grace if the runner ignores the interrupt.
  await vi.waitFor(async () => {
    await h.clock.advance(1_000);
    expect(ended.map((r) => [r.seq, r.state])).toEqual([[2, "timeout"]]);
  }, WAIT);
  expect(unwrap(await listRuns(h.db, "S"))[1]).toMatchObject({
    state: "timeout",
    error_message: "no terminal within 1000 ms",
  });
  // The process is gone: its EOF closed run 2, and the slot is free.
  const terminals = unwrap(
    await getEventsSince(h.db, {
      sessionId: "S",
      since: 0,
      kinds: ["terminal"],
      limit: 10,
    }),
  ).rows;
  expect(terminals).toHaveLength(2);
  expect(h.slots.capacity().used).toBe(0);
  expect(unwrap(await getSession(h.db, "S")).state).toBe("handoff_writing");
});

test("a run that fails to start returns an idle session to idle, and leaves handoff_writing alone", async () => {
  const h = await setup();
  unwrap(await h.spawn("S", { prompt: "first" }));
  await h.idle("S", 1);
  h.control.failSend = true;
  const refused = {
    ok: false,
    error: { class: "runner_error", message: "send refused" },
  };
  expect(await h.lifecycle.startRun("S", operator(2))).toMatchObject(refused);
  await h.lifecycle.settled();
  expect(unwrap(await getSession(h.db, "S")).state).toBe("idle");
  unwrap(await updateSessionState(h.db, "S", toHandoffWriting));
  expect(await h.lifecycle.startRun("S", handoff(3))).toMatchObject(refused);
  await h.lifecycle.settled();
  const states = unwrap(await listRuns(h.db, "S")).map((r) => r.state);
  expect(states).toEqual(["ok", "failed", "failed"]);
  expect(unwrap(await getSession(h.db, "S")).state).toBe("handoff_writing");
});

test("a start whose startRun move itself fails keeps the move's class, conflict, so it holds no pair", async () => {
  const h = await setup();
  unwrap(await h.spawn("S", { prompt: "first" }));
  await h.idle("S", 1);
  h.control.flipOnEstimate = "S";
  expect(await h.lifecycle.startRun("S", operator(2))).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
  await h.lifecycle.settled();
  expect(unwrap(await listRuns(h.db, "S"))[1]).toMatchObject({
    state: "failed",
    error_class: "conflict",
  });
  expect(
    unwrap(
      await listPairFailuresSince(h.db, {
        runnerId: h.runnerId,
        executorId: EXECUTOR_ID,
        since: 0,
      }),
    ),
  ).toEqual([]);
});

test("a start that the supervisor's own step failed keeps that step's class, so it holds no pair", async () => {
  const h = await setup();
  unwrap(await h.spawn("S", { prompt: "first" }));
  await h.idle("S", 1);
  h.control.failOpen = true;
  expect(await h.lifecycle.startRun("S", operator(2))).toMatchObject({
    ok: false,
    error: { class: "db_busy" },
  });
  await h.lifecycle.settled();
  expect(unwrap(await listRuns(h.db, "S"))[1]).toMatchObject({
    state: "failed",
    error_class: "db_busy",
  });
  expect(unwrap(await getSession(h.db, "S")).state).toBe("idle");
  // The retry storm counts runner_error only: this failure holds no (runner, executor) pair.
  expect(
    unwrap(
      await listPairFailuresSince(h.db, {
        runnerId: h.runnerId,
        executorId: EXECUTOR_ID,
        since: 0,
      }),
    ),
  ).toEqual([]);
});

test("wallClockMs overrides the run class's wall clock for that run", async () => {
  const h = await setup({ script: SCRIPTS.gateSecond });
  unwrap(await h.spawn("S", { prompt: "first" }));
  await h.idle("S", 1);
  unwrap(
    await h.lifecycle.startRun("S", { ...operator(2), wallClockMs: 1_000 }),
  );
  await h.clock.advance(999);
  await h.lifecycle.settled();
  expect(unwrap(await listRuns(h.db, "S"))[1]?.state).toBe("running");
  await h.clock.advance(1); // build's own wall clock is 2 h
  await vi.waitFor(async () => {
    expect(unwrap(await listRuns(h.db, "S"))[1]).toMatchObject({
      state: "timeout",
      error_message: "no terminal within 1000 ms",
    });
  }, WAIT);
});
