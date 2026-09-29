// Per-run spend from a runner's running totals (§5.1, §8.9). Runners that report cost report it
// as a total for the whole process; a run's spend is the growth since the previous report. Pure
// and runner-neutral: every adapter's mapper uses it.
import type { Usage } from "@bayon/core";
import type { ModelRow } from "./adapter.js";

/** Tokens and cost for one model, either a running total or the delta of one. */
export type Totals = Usage & { readonly cost_usd: number };
export type ByModel = Readonly<Record<string, Totals>>;
export type CostSource = "reported" | "estimated";

/** A run's spend, carried by its `terminal` event and written to `spend`. */
export type Spend = Totals & {
  readonly cost_source: CostSource;
  /** The model with the largest cost delta; absent when no model spent anything. */
  readonly model?: string;
  readonly by_model: ByModel;
  /** Set when an estimate met a model with no price row, so its cost reads 0. */
  readonly unpriced?: true;
};

/**
 * One process segment's ledger. `previous` holds the last reported running totals (the baseline);
 * `carry` holds estimates already billed that the next real report will include again.
 */
export type SpendState = {
  readonly previous: ByModel;
  readonly carry: ByModel;
};

/** Each segment starts at zero, exactly when a runner's running totals restart. */
export const SPEND_START: SpendState = { previous: {}, carry: {} };

const FIELDS = [
  "tokens_in",
  "tokens_out",
  "tokens_cache_read",
  "tokens_cache_write",
  "cost_usd",
] as const;

const ZERO: Totals = {
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  cost_usd: 0,
};

const MTOK = 1_000_000;

// Nano-dollars: float subtraction must not leave 0.018000000000000002 in the ledger.
const roundUsd = (usd: number): number => Math.round(usd * 1e9) / 1e9;

function combine(
  a: Totals,
  b: Totals,
  op: (x: number, y: number) => number,
): Totals {
  return {
    tokens_in: op(a.tokens_in, b.tokens_in),
    tokens_out: op(a.tokens_out, b.tokens_out),
    tokens_cache_read: op(a.tokens_cache_read, b.tokens_cache_read),
    tokens_cache_write: op(a.tokens_cache_write, b.tokens_cache_write),
    cost_usd: roundUsd(op(a.cost_usd, b.cost_usd)),
  };
}

const add = (a: Totals, b: Totals): Totals => combine(a, b, (x, y) => x + y);
const growth = (a: Totals, b: Totals): Totals =>
  combine(a, b, (x, y) => Math.max(0, x - y));

export function isZero(totals: ByModel): boolean {
  return Object.values(totals).every((t) => FIELDS.every((f) => t[f] === 0));
}

/** True when any running total went down: the runner restarted its totals (e.g. a reset). */
function decreased(current: ByModel, previous: ByModel): boolean {
  return Object.entries(previous).some(([model, before]) => {
    const now = current[model] ?? ZERO;
    return FIELDS.some((f) => now[f] < before[f]);
  });
}

function summarize(
  byModel: ByModel,
  source: CostSource,
  unpriced: boolean,
): Spend {
  const models = Object.keys(byModel).toSorted();
  const total = models.reduce((sum, m) => add(sum, byModel[m] ?? ZERO), ZERO);
  const top = models.reduce<string | undefined>(
    (best, m) =>
      best === undefined ||
      (byModel[m]?.cost_usd ?? 0) > (byModel[best]?.cost_usd ?? 0)
        ? m
        : best,
    undefined,
  );
  return {
    ...total,
    cost_source: source,
    ...(top === undefined ? {} : { model: top }),
    by_model: byModel,
    ...(unpriced ? { unpriced: true } : {}),
  };
}

/**
 * Bills a real report: current − previous − carry per model and field, clamped at 0. A decrease
 * restarts the baseline at zero; the carry is spent either way.
 */
export function reported(
  state: SpendState,
  current: ByModel,
): { readonly state: SpendState; readonly spend: Spend } {
  const baseline = decreased(current, state.previous) ? {} : state.previous;
  const delta: ByModel = Object.fromEntries(
    Object.entries(current).map(([model, now]) => [
      model,
      growth(growth(now, baseline[model] ?? ZERO), state.carry[model] ?? ZERO),
    ]),
  );
  return {
    state: { previous: current, carry: {} },
    spend: summarize(delta, "reported", false),
  };
}

/**
 * Bills an estimate for a run whose report came back zeroed. The baseline is kept and the estimate
 * joins the carry, so the next real report, which includes this run, does not bill it twice.
 */
export function estimated(
  state: SpendState,
  estimate: ByModel,
  unpriced: boolean,
): { readonly state: SpendState; readonly spend: Spend } {
  const carry: ByModel = Object.fromEntries(
    [...new Set([...Object.keys(state.carry), ...Object.keys(estimate)])].map(
      (model) => [
        model,
        add(state.carry[model] ?? ZERO, estimate[model] ?? ZERO),
      ],
    ),
  );
  return {
    state: { previous: state.previous, carry },
    spend: summarize(estimate, "estimated", unpriced),
  };
}

/** The row for `model`: an exact match, or the model a dated snapshot (`<model>-YYYYMMDD`) names. */
function rowFor(
  rows: readonly ModelRow[],
  model: string,
): ModelRow | undefined {
  return (
    rows.find((r) => r.model === model) ??
    rows.find(
      (r) =>
        model.startsWith(`${r.model}-`) &&
        /^\d{8}$/.test(model.slice(r.model.length + 1)),
    )
  );
}

/** Prices tokens from the models table (§5.1 `costReporting` absent or zeroed). */
export function price(
  rows: readonly ModelRow[],
  model: string,
  usage: Usage,
): { readonly totals: Totals; readonly unpriced: boolean } {
  const row = rowFor(rows, model);
  const cost =
    row === undefined
      ? 0
      : (usage.tokens_in * row.priceInPerMtok +
          usage.tokens_out * row.priceOutPerMtok +
          usage.tokens_cache_read * row.priceCacheReadPerMtok +
          usage.tokens_cache_write * row.priceCacheWritePerMtok) /
        MTOK;
  return {
    totals: { ...usage, cost_usd: roundUsd(cost) },
    unpriced: row === undefined,
  };
}
