import { describe, expect, test } from "vitest";
import type { ModelRow } from "./adapter.js";
import {
  SPEND_START,
  estimated,
  isZero,
  price,
  reported,
  type ByModel,
  type Totals,
} from "./spend.js";

const totals = (
  tokens_in: number,
  tokens_out: number,
  cost_usd: number,
  cache: { read?: number; write?: number } = {},
): Totals => ({
  tokens_in,
  tokens_out,
  tokens_cache_read: cache.read ?? 0,
  tokens_cache_write: cache.write ?? 0,
  cost_usd,
});

const ROWS: readonly ModelRow[] = [
  {
    id: "r.cheap",
    tier: "cheap",
    model: "model-small",
    priceInPerMtok: 1,
    priceOutPerMtok: 5,
    priceCacheReadPerMtok: 0.1,
    priceCacheWritePerMtok: 1.25,
    contextTokens: 200_000,
  },
];

describe("reported running totals", () => {
  test("the first report of a segment is its own delta", () => {
    const current: ByModel = { "model-a": totals(100, 20, 0.012, { read: 5 }) };
    const { spend } = reported(SPEND_START, current);
    expect(spend).toEqual({
      ...totals(100, 20, 0.012, { read: 5 }),
      cost_source: "reported",
      model: "model-a",
      by_model: current,
    });
  });

  test("a later report bills only what grew since the previous one", () => {
    const first = reported(SPEND_START, { "model-a": totals(100, 20, 0.012) });
    const { spend } = reported(first.state, {
      "model-a": totals(250, 50, 0.03),
    });
    expect(spend.tokens_in).toBe(150);
    expect(spend.tokens_out).toBe(30);
    expect(spend.cost_usd).toBe(0.018);
  });

  test("the model is the one with the largest cost delta", () => {
    const { spend } = reported(SPEND_START, {
      "model-a": totals(10, 1, 0.001),
      "model-b": totals(10, 1, 0.004),
      "model-c": totals(10, 1, 0.002),
    });
    expect(spend.model).toBe("model-b");
    expect(spend.tokens_in).toBe(30);
    expect(spend.cost_usd).toBe(0.007);
  });

  test("a decrease (a reset of the running totals) restarts the baseline", () => {
    const first = reported(SPEND_START, { "model-a": totals(500, 90, 0.05) });
    const { spend } = reported(first.state, {
      "model-a": totals(40, 10, 0.004),
    });
    expect(spend.tokens_in).toBe(40);
    expect(spend.cost_usd).toBe(0.004);
  });

  test("no models and no totals is a zero, reported spend with no model", () => {
    const { spend } = reported(SPEND_START, {});
    expect(spend).toEqual({
      ...totals(0, 0, 0),
      cost_source: "reported",
      by_model: {},
    });
  });

  test("never mutates the state it was given", () => {
    const state = Object.freeze({
      previous: Object.freeze({}),
      carry: Object.freeze({}),
    });
    expect(() =>
      reported(state, { "model-a": totals(1, 1, 0.1) }),
    ).not.toThrow();
    expect(state.previous).toEqual({});
  });
});

describe("estimates and the carry", () => {
  test("an estimate is billed once and subtracted from the next real report", () => {
    const run1 = estimated(
      SPEND_START,
      { "model-a": totals(100, 20, 0.01) },
      false,
    );
    expect(run1.spend.cost_source).toBe("estimated");
    expect(run1.spend.cost_usd).toBe(0.01);
    expect(run1.spend.unpriced).toBeUndefined();

    // The runner's real totals cover run 1 and run 2 together.
    const run2 = reported(run1.state, { "model-a": totals(300, 60, 0.035) });
    expect(run2.spend.cost_source).toBe("reported");
    expect(run2.spend.tokens_in).toBe(200);
    expect(run2.spend.tokens_out).toBe(40);
    expect(run2.spend.cost_usd).toBe(0.025);

    // The carry is spent: a third report bills only its own growth.
    const run3 = reported(run2.state, { "model-a": totals(310, 61, 0.036) });
    expect(run3.spend.tokens_in).toBe(10);
    expect(run3.spend.cost_usd).toBe(0.001);
  });

  test("a carry larger than the growth clamps at zero, never negative", () => {
    const run1 = estimated(
      SPEND_START,
      { "model-a": totals(1_000, 100, 0.5) },
      false,
    );
    const { spend } = reported(run1.state, {
      "model-a": totals(10, 1, 0.001),
    });
    expect(spend).toMatchObject(totals(0, 0, 0));
  });

  test("an unpriced estimate says so", () => {
    const { spend } = estimated(
      SPEND_START,
      { "model-x": totals(10, 1, 0) },
      true,
    );
    expect(spend.unpriced).toBe(true);
    expect(spend.cost_usd).toBe(0);
  });
});

describe("price", () => {
  const usage = {
    tokens_in: 1_000_000,
    tokens_out: 100_000,
    tokens_cache_read: 2_000_000,
    tokens_cache_write: 400_000,
  };

  test("prices tokens with the matching model row", () => {
    expect(price(ROWS, "model-small", usage)).toEqual({
      // 1 M in × $1 + 0.1 M out × $5 + 2 M cache read × $0.10 + 0.4 M cache write × $1.25
      totals: { ...usage, cost_usd: 2.2 },
      unpriced: false,
    });
  });

  test("a dated snapshot of a model uses that model's row", () => {
    expect(price(ROWS, "model-small-20260101", usage).unpriced).toBe(false);
  });

  test("a model with no row costs zero and is flagged unpriced", () => {
    expect(price(ROWS, "model-smaller", usage)).toEqual({
      totals: { ...usage, cost_usd: 0 },
      unpriced: true,
    });
  });
});

test("isZero is true only when every field of every model is zero", () => {
  expect(isZero({})).toBe(true);
  expect(isZero({ a: totals(0, 0, 0) })).toBe(true);
  expect(isZero({ a: totals(0, 0, 0), b: totals(0, 0, 0.0001) })).toBe(false);
  expect(isZero({ a: totals(0, 0, 0, { write: 1 }) })).toBe(false);
});
