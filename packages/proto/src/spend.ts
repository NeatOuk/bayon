import { z } from "zod";
import { TicketEconomics } from "./tickets.js";

// The spend ledger's roll-ups (§8.9): `GET /spend?group=` (§12.1) and the `spend` WS topic (§12.2).
// Days are UTC; a trailing window is (now − length, now].

const usd = z.number().nonnegative();
const count = z.int().nonnegative();
const epochMs = z.int();

export const SpendGroup = z.enum(["ticket", "tier", "class", "day"]);
export type SpendGroup = z.infer<typeof SpendGroup>;

/**
 * `GET /spend?group=&project=`; the group is `day` when absent. With `project` every figure is that
 * project's, the summary included: a row's project is its ticket's, else its session's,
 * else that session's agent's, else its pulse's agent's. A filter, so an unknown project is zeros.
 */
export const SpendQuery = z.object({
  group: SpendGroup.default("day"),
  project: z.string().min(1).max(64).optional(),
});
export type SpendQuery = z.infer<typeof SpendQuery>;

/** One window's mean daily burn against the baseline before it. */
export const BurnMove = z.object({
  daily_usd: usd,
  /** Null when nothing was spent before the window. */
  baseline_daily_usd: usd.nullable(),
  /** Null without a baseline, or when it is zero. */
  change_pct: z.number().nullable(),
  /** change_pct > the threshold: burn rose (a rise only). */
  alarm: z.boolean(),
  /** change_pct < −the threshold: burn fell. News, never an alarm. */
  drop: z.boolean(),
});
export type BurnMove = z.infer<typeof BurnMove>;

/** The headline numbers, and the `data` of every `spend` frame. */
export const SpendSummary = z.object({
  /** The last `spend.baseline_days` days: (from, to]. */
  window: z.object({ from: epochMs, to: epochMs }),
  total_usd: usd,
  wasted_usd: usd,
  /** wasted ÷ total × 100 over the window; null when nothing was spent. Target < 15. */
  waste_pct: z.number().nonnegative().nullable(),
  burn: z.object({
    today_usd: usd,
    month_to_date_usd: usd,
    /** Month-to-date ÷ time elapsed × the month's length. */
    projected_month_usd: usd,
  }),
  alarm: z.object({
    threshold_pct: z.number().positive(),
    baseline_days: z.int().positive(),
    last_day: BurnMove,
    last_7d: BurnMove,
    /** Either window alarms: the only destructive signal. */
    active: z.boolean(),
    /** The fleet is paused, or on a project's summary that project is. */
    paused: z.boolean(),
    /** Either window dropped and nothing is paused: a calm note, not an alarm. */
    dropped: z.boolean(),
  }),
});
export type SpendSummary = z.infer<typeof SpendSummary>;

/** A ticket with spend: its `v_ticket_economics` row. */
export const TicketSpend = TicketEconomics.extend({
  id: z.string(),
  num: z.int().positive(),
  title: z.string(),
  status: z.string(),
  complexity_tier: z.string(),
});
export type TicketSpend = z.infer<typeof TicketSpend>;

/** Cost per closed (done) ticket of one tier; percentiles are nearest-rank. */
export const TierSpend = z.object({
  tier: z.string(),
  closed_tickets: z.int().positive(),
  cost_p50_usd: usd,
  cost_p95_usd: usd,
  cost_total_usd: usd,
  review_rounds_avg: z.number().nonnegative(),
  handoffs_avg: z.number().nonnegative(),
});
export type TierSpend = z.infer<typeof TierSpend>;

/** Tokens and cost of one run class over the window. */
export const ClassSpend = z.object({
  run_class: z.string(),
  runs: count,
  tokens_in: count,
  tokens_out: count,
  tokens_cache_read: count,
  tokens_cache_write: count,
  /** Estimated tokens context compression kept out of the input (chars/4). */
  tokens_saved: count.default(0),
  cost_usd: usd,
  wasted_usd: usd,
});
export type ClassSpend = z.infer<typeof ClassSpend>;

/** One UTC day; the window's days are all present, oldest first. */
export const DailySpend = z.object({
  day: epochMs,
  runs: count,
  cost_usd: usd,
  wasted_usd: usd,
  /** Estimated tokens context compression kept out of the input that day. */
  tokens_saved: count.default(0),
});
export type DailySpend = z.infer<typeof DailySpend>;

/** `GET /spend?group=`: the summary and that grouping's rows. */
export const SpendReport = z.discriminatedUnion("group", [
  z.object({
    group: z.literal("ticket"),
    summary: SpendSummary,
    rows: z.array(TicketSpend),
  }),
  z.object({
    group: z.literal("tier"),
    summary: SpendSummary,
    rows: z.array(TierSpend),
  }),
  z.object({
    group: z.literal("class"),
    summary: SpendSummary,
    rows: z.array(ClassSpend),
  }),
  z.object({
    group: z.literal("day"),
    summary: SpendSummary,
    rows: z.array(DailySpend),
  }),
]);
export type SpendReport = z.infer<typeof SpendReport>;
