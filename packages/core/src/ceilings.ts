// In-flight ceilings (§7.1, §8.4, §13.2): the pure half of the supervisor's lifecycle/ceilings.ts,
// which M4's watchdog calls too. Context % and cost come from reported usage only; the verdict is
// nothing, a hand-off (soft) or a stop (hard). Every threshold is an input: run class or setting.
import type { Usage } from "./events/schema.js";
import type { RunClass } from "./run-classes.js";

/** A `models` row's prices, USD per million tokens; null = unpriced. */
export interface ModelPrices {
  readonly price_in_per_mtok: number | null;
  readonly price_out_per_mtok: number | null;
  readonly price_cache_read_per_mtok: number | null;
  readonly price_cache_write_per_mtok: number | null;
}

export const ZERO_USAGE: Usage = Object.freeze({
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  tokens_in: a.tokens_in + b.tokens_in,
  tokens_out: a.tokens_out + b.tokens_out,
  tokens_cache_read: a.tokens_cache_read + b.tokens_cache_read,
  tokens_cache_write: a.tokens_cache_write + b.tokens_cache_write,
});

/** The prompt one step sent: input + cache read + cache write tokens (§7.1's context). */
export const contextTokensOf = (u: Usage): number =>
  u.tokens_in + u.tokens_cache_read + u.tokens_cache_write;

/** The window a session's context % is measured against, and whether the run class's cap was cut. */
export interface EffectiveWindow {
  /** min(cap, window); either alone when the other is n/a; undefined when both are. */
  readonly tokens: number | undefined;
  /** The run class's cap was above the model's window, so the window stands in for it. */
  readonly clamped?: {
    readonly capTokens: number;
    readonly windowTokens: number;
  };
}

/**
 * min(run_classes.context_tokens_cap, models.context_tokens): a run class's cap above
 * the model's window can never outrun it, so the context ceiling fires before the runner refuses
 * the prompt. A 0 cap is n/a (run class convention); a null or non-positive window is unknown.
 * Unknown on both sides stays unknown: no context trigger, never guessed.
 */
export function effectiveWindow(
  capTokens: number,
  windowTokens: number | null | undefined,
): EffectiveWindow {
  const window =
    windowTokens != null && windowTokens > 0 ? windowTokens : undefined;
  const cap = capTokens > 0 ? capTokens : undefined;
  if (window === undefined || cap === undefined) {
    return { tokens: cap ?? window };
  }
  return cap > window
    ? { tokens: window, clamped: { capTokens: cap, windowTokens: window } }
    : { tokens: cap };
}

/** Context use as a % of the model's window; undefined if either is unknown, never guessed. */
export function contextPct(
  u: Usage | undefined,
  windowTokens: number | null | undefined,
): number | undefined {
  if (u === undefined || windowTokens == null || windowTokens <= 0) {
    return undefined;
  }
  return (contextTokensOf(u) * 100) / windowTokens;
}

/** tokens × prices in USD; undefined if a token kind in use has no price. */
export function priceUsage(u: Usage, p: ModelPrices): number | undefined {
  const parts: readonly (readonly [number, number | null])[] = [
    [u.tokens_in, p.price_in_per_mtok],
    [u.tokens_out, p.price_out_per_mtok],
    [u.tokens_cache_read, p.price_cache_read_per_mtok],
    [u.tokens_cache_write, p.price_cache_write_per_mtok],
  ];
  if (parts.some(([tokens, price]) => tokens > 0 && price === null)) {
    return undefined;
  }
  return parts.reduce(
    (usd, [tokens, price]) => usd + (tokens * (price ?? 0)) / 1_000_000,
    0,
  );
}

/**
 * What a session's `turn_end` usage has shown so far, folded one event at a time from `cursor`
 * (an events.id) on. A usage that arrives late (a step behind, or with the terminal) still lands
 * on the run and step it reports, so it is counted whenever it commits.
 */
export interface UsageTally {
  readonly cursor: number;
  /** The latest `turn_end` that reported usage: the context now. */
  readonly last?: Usage;
  /** The largest context any step reported. */
  readonly peakTokens?: number;
  /** The latest run's summed step usage: its cost so far, until its spend row settles it. */
  readonly run?: { readonly id: string; readonly usage: Usage };
}

export const EMPTY_TALLY: UsageTally = Object.freeze({ cursor: 0 });

/** Folds one stored `turn_end`: its id, its run, and its usage if the runner reported one. */
export function tallyTurnEnd(
  t: UsageTally,
  e: { readonly id: number; readonly runId?: string; readonly usage?: Usage },
): UsageTally {
  const cursor = Math.max(t.cursor, e.id);
  if (e.usage === undefined) return { ...t, cursor };
  const tokens = contextTokensOf(e.usage);
  const run =
    e.runId === undefined
      ? t.run
      : {
          id: e.runId,
          usage: addUsage(
            t.run?.id === e.runId ? t.run.usage : ZERO_USAGE,
            e.usage,
          ),
        };
  return {
    cursor,
    last: e.usage,
    peakTokens: Math.max(t.peakTokens ?? 0, tokens),
    ...(run === undefined ? {} : { run }),
  };
}

export type HardCap = "max_turns" | "max_tool_calls" | "cost_cap_usd";
/** The §7.1 daemon triggers, named as `handoffs.reason` names them. */
export type SoftReason = "context_ceiling" | "turn_ceiling" | "budget";

export type CeilingVerdict =
  | { readonly kind: "none" }
  | {
      readonly kind: "hard";
      readonly cap: HardCap;
      readonly value: number;
      readonly limit: number;
    }
  | {
      readonly kind: "soft";
      readonly reason: SoftReason;
      readonly value: number;
      readonly limit: number;
    };

export interface CeilingInput {
  readonly turns: number;
  readonly toolCalls: number;
  readonly costUsd: number;
  /** undefined when the runner reported no usage or the model has no window: no context trigger. */
  readonly contextPct: number | undefined;
  readonly runClass: Pick<
    RunClass,
    | "max_turns"
    | "max_tool_calls"
    | "cost_cap_usd"
    | "handoff_at_turns"
    | "handoff_at_context_pct"
  >;
  /** §7.1's budget trigger, as a % of cost_cap_usd (the spec's 0.8 is 80). 0 = off. */
  readonly handoffAtCostPct: number;
}

const NONE: CeilingVerdict = Object.freeze({ kind: "none" });

/**
 * A hard cap reached (≥; a 0 cap is n/a) wins over any soft threshold. Soft order: context,
 * turns, cost. The caller acts on it: stop, or ask for a hand-off once.
 */
export function judgeCeilings(i: CeilingInput): CeilingVerdict {
  const rc = i.runClass;
  const hard: readonly (readonly [HardCap, number, number])[] = [
    ["max_turns", i.turns, rc.max_turns],
    ["max_tool_calls", i.toolCalls, rc.max_tool_calls],
    ["cost_cap_usd", i.costUsd, rc.cost_cap_usd],
  ];
  for (const [cap, value, limit] of hard) {
    if (limit > 0 && value >= limit) return { kind: "hard", cap, value, limit };
  }
  const costAt = (rc.cost_cap_usd * i.handoffAtCostPct) / 100;
  const soft: readonly (readonly [SoftReason, number | undefined, number])[] = [
    ["context_ceiling", i.contextPct, rc.handoff_at_context_pct],
    ["turn_ceiling", i.turns, rc.handoff_at_turns],
    ["budget", i.costUsd, costAt],
  ];
  for (const [reason, value, limit] of soft) {
    if (limit > 0 && value !== undefined && value >= limit) {
      return { kind: "soft", reason, value, limit };
    }
  }
  return NONE;
}
