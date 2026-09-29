// The in-flight ceilings end to end (§7.1, §13.2): the fixture runner on the local
// executor, a real git worktree and SQLite file, a FakeClock, and turn_end usage scripted as the
// runner would report it. Prices and the context window come from the `models` rows.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, type Usage } from "@bayon/core";
import {
  getEventsSince,
  listRuns,
  listSessionsInStates,
  type Db,
} from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  FIXTURE_RUNNER_ID,
  createFixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, describe, expect, test, vi } from "vitest";
import { EXECUTOR_ID, startLifecycle, tempHome } from "./testing/fixtures.js";
import {
  TE,
  TINY,
  TS,
  capturing,
  handoffsOf,
  makeRepo,
  session,
  spawnOn,
  turns,
  waitFor,
  waitState,
  worktreeOf,
  worldRows,
  type World,
} from "./testing/handoff-world.js";

vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;

/** Ceilings off except the context % (70) and cost (80 % of $5); tests turn on the rest. */
const CEIL = {
  ...TINY,
  name: "ceil",
  handoff_at_turns: 0,
  max_turns: 60,
  max_tool_calls: 100,
  cost_cap_usd: 5,
  handoff_at_context_pct: 70,
};

/** A 1000-token window by default; $1 in, $5 out, $0.10 cache read, $1.25 cache write per Mtok. */
const modelsWith = (window: number | null) =>
  (["complex", "standard", "cheap"] as const).map((tier) => ({
    id: `${FIXTURE_RUNNER_ID}.${tier}`,
    runner_id: FIXTURE_RUNNER_ID,
    tier,
    model: "fixture-model",
    context_tokens: window,
    price_in_per_mtok: 1,
    price_out_per_mtok: 5,
    price_cache_read_per_mtok: 0.1,
    price_cache_write_per_mtok: 1.25,
  }));

/** A top-level step's end carrying the runner's reported usage. */
const TEU = (u: Partial<Usage>) => ({
  ...TE,
  payload: {
    usage: {
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      ...u,
    },
  },
});
const CALL = (n: number) => ({
  kind: "tool_call",
  runner_type: "fixture.step",
  tool_name: "Bash",
  payload: { call_id: `call-${n}` },
});

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function setup(o: {
  script: FixtureScriptInput;
  runClass?: Partial<typeof CEIL>;
  /** The models' context_tokens; default 1000. */
  window?: number | null;
}): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-ceil-");
  const { src, mirror } = makeRepo(home.path);
  const rows = worldRows({ script: o.script, src, mirror });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      models: modelsWith(o.window === undefined ? 1_000 : o.window),
      run_classes: [{ ...CEIL, ...o.runClass }],
    }),
  );
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const fixture = capturing(createFixtureAdapter({ clock }));
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: fixture.adapter,
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    const live = await listSessionsInStates(t.db, [
      "running",
      "idle",
      "stopping",
      "handoff_writing",
    ]);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await executor.cleanup(s.executor_ref, "hard");
    }
    t.cleanup();
    home.cleanup();
  });
  return {
    ...started,
    db: t.db,
    clock,
    executor,
    slots,
    src,
    mirror,
    release: fixture.release,
    adopts: fixture.adopts,
    stops: fixture.stops,
  };
}

const spawn = (w: World) => spawnOn(w, "s1", { run_class: CEIL.name });

const runsOf = async (db: Db) =>
  unwrap(await listRuns(db, "s1")).map((r) => [r.trigger, r.state]);

const terminalsOf = async (db: Db, runId: string | undefined) =>
  unwrap(
    await getEventsSince(db, { sessionId: "s1", since: 0, limit: 1000 }),
  ).rows.filter((e) => e.kind === "terminal" && e.run_id === runId);

const asks = (w: World) =>
  w.logs.filter((l) => l.msg === "ceiling: hand off").length;

describe("a soft threshold hands off, once (§7.1)", () => {
  test.each([
    // 600 in + 150 cache read of a 1000-token window: 75 % ≥ 70 %.
    [
      "context_ceiling",
      {},
      [TS, TEU({ tokens_in: 600, tokens_cache_read: 150 })],
    ],
    ["turn_ceiling", { handoff_at_turns: 2 }, turns(3)],
    // No reported cost: 820k out × $5/Mtok = $4.10 ≥ 80 % of $5.
    ["budget", {}, [TS, TEU({ tokens_in: 100, tokens_out: 820_000 })]],
  ] as const)("%s", async (reason, runClass, events) => {
    const w = await setup({
      runClass,
      script: {
        runs: [
          { events: [...events], gate: "release" },
          { events: turns(1), gate: "release" },
        ],
      },
    });
    await spawn(w);
    await waitFor(w, async () => {
      expect(await runsOf(w.db)).toEqual([
        ["operator", "interrupted"],
        ["handoff", "running"],
      ]);
    });
    expect((await session(w.db, "s1")).state).toBe("handoff_writing");
    const rows = await handoffsOf(w.db, "s1");
    expect(rows.map((r) => [r.reason, r.quality])).toEqual([
      [reason, "writing"],
    ]);
    expect(asks(w)).toBe(1);
  });

  test("a usage that arrives with the run's end still hands off (the SDK's one-step lag)", async () => {
    const w = await setup({
      script: {
        runs: [
          // The last step's usage lands just before the terminal: the session goes idle.
          { events: [TS, TE, TS, TEU({ tokens_in: 800 })] },
          { events: turns(1), gate: "release" },
        ],
      },
    });
    await spawn(w);
    await waitFor(w, async () => {
      expect(await runsOf(w.db)).toEqual([
        ["operator", "ok"],
        ["handoff", "running"],
      ]);
    });
    const [row] = await handoffsOf(w.db, "s1");
    expect(row?.reason).toBe("context_ceiling");
    expect((await session(w.db, "s1")).context_peak_tokens).toBe(800);
    expect(asks(w)).toBe(1);
  });

  test("no usage reported: no context trigger, no peak, never guessed", async () => {
    const w = await setup({
      script: { runs: [{ events: turns(3), gate: "release" }] },
    });
    await spawn(w);
    await waitFor(w, async () => {
      expect((await session(w.db, "s1")).turns).toBe(3);
    });
    await w.release("s1");
    await waitState(w, "s1", "idle");
    expect(await session(w.db, "s1")).toMatchObject({
      context_peak_tokens: null,
      handoff_out_id: null,
    });
    expect(await handoffsOf(w.db, "s1")).toEqual([]);
    expect(asks(w)).toBe(0);
  });
});

// a build session on sonnet ran to a context of ~177k behind the context proxy, where the
// CLI's window is 200k, and died "Prompt is too long" at the CLI's own limit. Its models row claimed
// 1M, so the trigger sat at 700k, and build's cap (300k) was above the real window too. The window
// the ceiling measures against is now min(run class cap, model window).
describe("the context ceiling is of min(run class cap, model window)", () => {
  const clampWarnings = (w: World) =>
    w.logs.filter((l) =>
      l.msg.startsWith("ceiling: the run class's context cap"),
    );
  const askedAt = (w: World) =>
    w.logs.find((l) => l.msg === "ceiling: hand off")?.obj as
      { readonly reason?: string; readonly value?: number } | undefined;

  test("a 300k cap on a 200k window hands off at 70 % of 200k, not before, and warns of the clamp once", async () => {
    const w = await setup({
      window: 200_000,
      runClass: { context_tokens_cap: 300_000 },
      script: {
        runs: [
          {
            events: [
              // 139k of 200k: 69.5 %, below the trigger (of the 1M claimed before: 13.9 %).
              TS,
              TEU({ tokens_in: 2_000, tokens_cache_read: 137_000 }),
              // 141k of 200k: 70.5 %.
              TS,
              TEU({ tokens_in: 2_000, tokens_cache_read: 139_000 }),
            ],
            gate: "release",
          },
          { events: turns(1), gate: "release" },
        ],
      },
    });
    await spawn(w);
    await waitFor(w, async () => {
      expect(await runsOf(w.db)).toEqual([
        ["operator", "interrupted"],
        ["handoff", "running"],
      ]);
    });
    const [row] = await handoffsOf(w.db, "s1");
    expect(row?.reason).toBe("context_ceiling");
    expect(askedAt(w)).toMatchObject({ reason: "context_ceiling", limit: 70 });
    expect(askedAt(w)?.value).toBeCloseTo(70.5, 9);
    expect((await session(w.db, "s1")).context_peak_tokens).toBe(141_000);
    expect(asks(w)).toBe(1);
    // Every check measured the same clamp; the operator is told once, with the cap to lower.
    expect(clampWarnings(w)).toHaveLength(1);
    expect(clampWarnings(w)[0]?.obj).toMatchObject({
      sessionId: "s1",
      runClass: CEIL.name,
      capTokens: 300_000,
      windowTokens: 200_000,
    });
  });

  test("a cap below the window is the window: 70 % of a 1000-token cap on a 200k model", async () => {
    const w = await setup({
      window: 200_000,
      runClass: { context_tokens_cap: 1_000 },
      script: {
        runs: [
          // 750 of the 1000 cap: 75 % (of the model's 200k alone: 0.4 %).
          { events: [TS, TEU({ tokens_in: 750 })], gate: "release" },
          { events: turns(1), gate: "release" },
        ],
      },
    });
    await spawn(w);
    await waitFor(w, async () => {
      expect(await runsOf(w.db)).toEqual([
        ["operator", "interrupted"],
        ["handoff", "running"],
      ]);
    });
    expect((await handoffsOf(w.db, "s1"))[0]?.reason).toBe("context_ceiling");
    expect(askedAt(w)?.value).toBeCloseTo(75, 9);
    expect(clampWarnings(w)).toEqual([]);
  });

  test("a model with no window: the cap alone still bounds the context", async () => {
    const w = await setup({
      window: null,
      runClass: { context_tokens_cap: 1_000 },
      script: {
        runs: [
          { events: [TS, TEU({ tokens_in: 800 })], gate: "release" },
          { events: turns(1), gate: "release" },
        ],
      },
    });
    await spawn(w);
    await waitFor(w, async () => {
      expect((await handoffsOf(w.db, "s1"))[0]?.reason).toBe("context_ceiling");
    });
    expect(clampWarnings(w)).toEqual([]);
  });
});

describe("sessions.cost_usd and context_peak_tokens mid-run", () => {
  test("cost from prices while the run is open; its reported spend replaces it", async () => {
    const w = await setup({
      script: {
        runs: [
          {
            events: [TS, TEU({ tokens_in: 200, tokens_out: 100_000 })],
            gate: "release",
          },
        ],
      },
    });
    await spawn(w);
    // 200 × $1 + 100k × $5 per Mtok; the context is 200 of 1000 (20 %): no trigger.
    await waitFor(w, async () => {
      const s = await session(w.db, "s1");
      expect(s.cost_usd).toBeCloseTo(0.5002, 9);
      expect(s.context_peak_tokens).toBe(200);
    });
    expect((await session(w.db, "s1")).state).toBe("running");
    await w.release("s1");
    await waitState(w, "s1", "idle");
    // The fixture reports $0.001 for the run: the terminal's spend is the cost now.
    expect((await session(w.db, "s1")).cost_usd).toBeCloseTo(0.001, 9);
  });
});

describe("a hard cap ends the run budget_stop and stops the session (§13.2)", () => {
  test.each([
    ["max_turns", { max_turns: 3 }, turns(3)],
    [
      "max_tool_calls",
      { max_tool_calls: 3 },
      [TS, CALL(1), CALL(2), CALL(3), TE],
    ],
    // 1M out × $5/Mtok = $5: the cap itself, past the 80 % hand-off, and the cap wins.
    ["cost_cap_usd", {}, [TS, TEU({ tokens_out: 1_000_000 })]],
  ] as const)("%s", async (cap, runClass, events) => {
    const w = await setup({
      runClass,
      script: { runs: [{ events: [...events], gate: "release" }] },
    });
    await spawn(w);
    await waitState(w, "s1", "exited");
    const s = await session(w.db, "s1");
    expect(s).toMatchObject({
      exit_reason: "error",
      error_class: "over_budget",
    });
    expect(s.error_message).toContain(cap);
    expect(await runsOf(w.db)).toEqual([["operator", "budget_stop"]]);
    // Its one terminal is the runner's answer to the interrupt, not a supervisor's (Invariant 3).
    const [run] = unwrap(await listRuns(w.db, "s1"));
    const terminals = await terminalsOf(w.db, run?.id);
    expect(terminals.map((e) => e.runner_type)).toEqual(["fixture.terminal"]);
    expect(w.stops()).toEqual(["graceful"]);
    // A holding session leaves a degraded hand-off, reason budget.
    await waitFor(w, async () => {
      const rows = await handoffsOf(w.db, "s1");
      expect(rows.map((r) => [r.reason, r.quality])).toEqual([
        ["budget", "degraded"],
      ]);
    });
    expect(asks(w)).toBe(0);
  });

  test("already handing off: it just stops, and the hand-off degrades", async () => {
    const w = await setup({
      runClass: { handoff_at_turns: 2, max_tool_calls: 3 },
      script: {
        runs: [
          { events: turns(3), gate: "release" },
          { events: [TS, CALL(1), CALL(2), CALL(3)], gate: "release" },
        ],
      },
    });
    await spawn(w);
    await waitState(w, "s1", "exited");
    expect(await session(w.db, "s1")).toMatchObject({
      exit_reason: "error",
      error_class: "over_budget",
    });
    // No budget_stop verdict on the handoff run, and no second hand-off.
    expect(await runsOf(w.db)).toEqual([
      ["operator", "interrupted"],
      ["handoff", "interrupted"],
    ]);
    await waitFor(w, async () => {
      const rows = await handoffsOf(w.db, "s1");
      expect(rows.map((r) => [r.reason, r.quality])).toEqual([
        ["turn_ceiling", "degraded"],
      ]);
    });
    const [row] = await handoffsOf(w.db, "s1");
    const text = readFileSync(
      join(await worktreeOf(w.db, "s1"), row?.packet_path ?? ""),
      "utf8",
    );
    expect(text).toContain("(no judgement: the cap hit)");
    expect(asks(w)).toBe(1);
  });
});
