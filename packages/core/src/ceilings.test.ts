import { describe, expect, test } from "vitest";
import {
  EMPTY_TALLY,
  ZERO_USAGE,
  addUsage,
  contextPct,
  contextTokensOf,
  effectiveWindow,
  judgeCeilings,
  priceUsage,
  tallyTurnEnd,
  type CeilingInput,
  type ModelPrices,
} from "./ceilings.js";

const usage = (
  tokens_in: number,
  tokens_out = 0,
  tokens_cache_read = 0,
  tokens_cache_write = 0,
) => ({ tokens_in, tokens_out, tokens_cache_read, tokens_cache_write });

const PRICES: ModelPrices = {
  price_in_per_mtok: 3,
  price_out_per_mtok: 15,
  price_cache_read_per_mtok: 0.3,
  price_cache_write_per_mtok: 3.75,
};

describe("context", () => {
  test("is input + cache read + cache write, never output", () => {
    expect(contextTokensOf(usage(100, 999, 20, 3))).toBe(123);
  });

  test("as a % of the model's window", () => {
    expect(contextPct(usage(600, 5, 100, 0), 1_000)).toBe(70);
  });

  test("unknown without usage or a window: never guessed", () => {
    expect(contextPct(undefined, 1_000)).toBeUndefined();
    expect(contextPct(usage(1), null)).toBeUndefined();
    expect(contextPct(usage(1), undefined)).toBeUndefined();
    expect(contextPct(usage(1), 0)).toBeUndefined();
  });
});

// a build class capped at 300k on a model whose CLI gives it 200k handed off at 70 % of
// the 1M the models row claimed, so never; the CLI refused the prompt at its own limit first.
describe("effectiveWindow: min(run class cap, model window)", () => {
  test("a cap above the window is clamped to the window, and says so", () => {
    expect(effectiveWindow(300_000, 200_000)).toEqual({
      tokens: 200_000,
      clamped: { capTokens: 300_000, windowTokens: 200_000 },
    });
  });

  test("a cap below the window is the window the ceiling measures against", () => {
    expect(effectiveWindow(150_000, 200_000)).toEqual({ tokens: 150_000 });
  });

  test("a cap equal to the window is no clamp", () => {
    expect(effectiveWindow(200_000, 200_000)).toEqual({ tokens: 200_000 });
  });

  test("a 0 cap is n/a: the model's window alone", () => {
    expect(effectiveWindow(0, 200_000)).toEqual({ tokens: 200_000 });
  });

  test("no window (null, undefined or not positive): the cap alone", () => {
    expect(effectiveWindow(25_000, null)).toEqual({ tokens: 25_000 });
    expect(effectiveWindow(25_000, undefined)).toEqual({ tokens: 25_000 });
    expect(effectiveWindow(25_000, 0)).toEqual({ tokens: 25_000 });
  });

  test("neither: unknown, never guessed", () => {
    expect(effectiveWindow(0, null)).toEqual({ tokens: undefined });
    expect(effectiveWindow(0, -1)).toEqual({ tokens: undefined });
  });

  test("the trigger moves with it: 70 % of the clamped 200k is 140k", () => {
    const { tokens } = effectiveWindow(300_000, 200_000);
    expect(contextPct(usage(139_000), tokens)).toBeLessThan(70);
    expect(contextPct(usage(140_000), tokens)).toBe(70);
  });
});

describe("priceUsage", () => {
  test("tokens × prices per million", () => {
    expect(priceUsage(usage(1_000_000, 100_000, 2_000_000, 0), PRICES)).toBe(
      3 + 1.5 + 0.6,
    );
  });

  test("an unpriced token kind in use is unknown; unused, it does not matter", () => {
    const noOut = { ...PRICES, price_out_per_mtok: null };
    expect(priceUsage(usage(10, 1), noOut)).toBeUndefined();
    expect(priceUsage(usage(1_000_000), noOut)).toBe(3);
  });

  test("no tokens cost nothing", () => {
    expect(priceUsage(ZERO_USAGE, PRICES)).toBe(0);
  });
});

describe("tallyTurnEnd", () => {
  test("keeps the latest usage, the peak context and the latest run's sum", () => {
    const t = [
      { id: 3, runId: "r1", usage: usage(500, 10) },
      { id: 4, runId: "r1" }, // no usage reported: only the cursor moves
      { id: 7, runId: "r1", usage: usage(300, 20, 100) },
    ].reduce(tallyTurnEnd, EMPTY_TALLY);
    expect(t).toEqual({
      cursor: 7,
      last: usage(300, 20, 100),
      peakTokens: 500,
      run: { id: "r1", usage: usage(800, 30, 100) },
    });
  });

  test("a new run starts a new sum; usage with no run keeps the last run", () => {
    const t = [
      { id: 1, runId: "r1", usage: usage(5) },
      { id: 2, runId: "r2", usage: usage(7) },
      { id: 3, usage: usage(9) },
    ].reduce(tallyTurnEnd, EMPTY_TALLY);
    expect(t.run).toEqual({ id: "r2", usage: usage(7) });
    expect(t.last).toEqual(usage(9));
    expect(t.peakTokens).toBe(9);
  });

  test("the cursor never moves back", () => {
    const t = tallyTurnEnd({ cursor: 9 }, { id: 2 });
    expect(t).toEqual({ cursor: 9 });
  });

  test("a usage with no run counts for the context, and no run is made up", () => {
    const t = tallyTurnEnd(EMPTY_TALLY, { id: 3, usage: usage(40, 1, 2) });
    expect(t).toEqual({ cursor: 3, last: usage(40, 1, 2), peakTokens: 42 });
  });

  test("adds usage field by field", () => {
    expect(addUsage(usage(1, 2, 3, 4), usage(10, 20, 30, 40))).toEqual(
      usage(11, 22, 33, 44),
    );
  });
});

describe("judgeCeilings", () => {
  const base: CeilingInput = {
    turns: 0,
    toolCalls: 0,
    costUsd: 0,
    contextPct: undefined,
    runClass: {
      max_turns: 120,
      max_tool_calls: 500,
      cost_cap_usd: 6,
      handoff_at_turns: 90,
      handoff_at_context_pct: 70,
    },
    handoffAtCostPct: 80,
  };
  const judge = (over: Partial<CeilingInput>) =>
    judgeCeilings({ ...base, ...over });

  test("under every threshold: nothing", () => {
    expect(
      judge({ turns: 89, toolCalls: 499, costUsd: 4.79, contextPct: 69 }),
    ).toEqual({ kind: "none" });
  });

  test.each([
    [{ turns: 120 }, "max_turns", 120, 120],
    [{ toolCalls: 501 }, "max_tool_calls", 501, 500],
    [{ costUsd: 6 }, "cost_cap_usd", 6, 6],
  ] as const)("hard cap %j → %s", (over, cap, value, limit) => {
    expect(judge(over)).toEqual({ kind: "hard", cap, value, limit });
  });

  test.each([
    [{ contextPct: 70 }, "context_ceiling", 70, 70],
    [{ turns: 90 }, "turn_ceiling", 90, 90],
    [{ costUsd: 4.8 }, "budget", 4.8, 4.8],
  ] as const)("soft threshold %j → %s", (over, reason, value, limit) => {
    expect(judge(over)).toMatchObject({ kind: "soft", reason, value });
    expect(judge(over)).toMatchObject({ limit: expect.closeTo(limit, 9) });
  });

  test("a hard cap wins over a soft threshold; context before turns before cost", () => {
    expect(judge({ contextPct: 99, costUsd: 6 })).toMatchObject({
      kind: "hard",
      cap: "cost_cap_usd",
    });
    expect(judge({ contextPct: 99, turns: 95, costUsd: 5 })).toMatchObject({
      reason: "context_ceiling",
    });
    expect(judge({ turns: 95, costUsd: 5 })).toMatchObject({
      reason: "turn_ceiling",
    });
  });

  test("a 0 cap or threshold is n/a", () => {
    const off = {
      max_turns: 0,
      max_tool_calls: 0,
      cost_cap_usd: 0,
      handoff_at_turns: 0,
      handoff_at_context_pct: 0,
    };
    expect(
      judge({
        runClass: off,
        turns: 1e6,
        toolCalls: 1e6,
        costUsd: 1e6,
        contextPct: 100,
      }),
    ).toEqual({ kind: "none" });
    expect(judge({ costUsd: 5.9, handoffAtCostPct: 0 })).toEqual({
      kind: "none",
    });
  });
});
