import type {
  BurnMove,
  ClassSpend,
  DailySpend,
  SpendSummary,
  TicketSpend,
  TierSpend,
} from "@bayon/proto";

// Wire-shaped spend data (DTOs): every value here would pass its proto schema.

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

export const quietMove: BurnMove = {
  daily_usd: 4,
  baseline_daily_usd: 4,
  change_pct: 0,
  alarm: false,
  drop: false,
};

export const spendSummary = (
  summary: Partial<SpendSummary> = {},
): SpendSummary => ({
  window: { from: T0 - 30 * DAY, to: T0 },
  total_usd: 42.5,
  wasted_usd: 3.8,
  waste_pct: 8.9,
  burn: {
    today_usd: 14.3,
    month_to_date_usd: 120.4,
    projected_month_usd: 310.2,
  },
  alarm: {
    threshold_pct: 25,
    baseline_days: 30,
    last_day: quietMove,
    last_7d: quietMove,
    active: false,
    paused: false,
    dropped: false,
  },
  ...summary,
});

/** Yesterday's burn 257.5 % over the 30-day baseline: the alarm is up. */
export const alarmedSummary = (): SpendSummary =>
  spendSummary({
    alarm: {
      threshold_pct: 25,
      baseline_days: 30,
      last_day: {
        daily_usd: 14.3,
        baseline_daily_usd: 4,
        change_pct: 257.5,
        alarm: true,
        drop: false,
      },
      last_7d: quietMove,
      active: true,
      paused: false,
      dropped: false,
    },
  });

/**
 * Nothing spent in the last day against $5.90 a day: a −100 % drop. Reported as a calm
 * note, or not at all while the fleet or project is `paused`.
 */
export const droppedSummary = (paused = false): SpendSummary =>
  spendSummary({
    alarm: {
      threshold_pct: 25,
      baseline_days: 30,
      last_day: {
        daily_usd: 0,
        baseline_daily_usd: 5.9,
        change_pct: -100,
        alarm: false,
        drop: true,
      },
      last_7d: quietMove,
      active: false,
      paused,
      dropped: !paused,
    },
  });

export const dailySpend = (daysAgo: number, costUsd: number): DailySpend => ({
  day: T0 - daysAgo * DAY,
  runs: 3,
  cost_usd: costUsd,
  wasted_usd: 0,
  tokens_saved: 0,
});

export const ticketSpend = (
  ticket: Partial<TicketSpend> & Pick<TicketSpend, "num">,
): TicketSpend => ({
  id: `ticket-${ticket.num}`,
  title: `ticket ${ticket.num}`,
  status: "build",
  complexity_tier: "standard",
  cost_usd: 6.3,
  cost_wasted_usd: 0.4,
  review_rounds: 1,
  handoff_count: 2,
  phase_handoff_count: 0,
  sessions: 3,
  tokens: 120_000,
  cache_ratio: 0.71,
  ...ticket,
});

export const tierSpend = (tier: string): TierSpend => ({
  tier,
  closed_tickets: 4,
  cost_p50_usd: 2.1,
  cost_p95_usd: 7.9,
  cost_total_usd: 12.4,
  review_rounds_avg: 1.5,
  handoffs_avg: 0.5,
});

export const classSpend = (runClass: string): ClassSpend => ({
  run_class: runClass,
  runs: 12,
  tokens_in: 400_000,
  tokens_out: 30_000,
  tokens_cache_read: 250_000,
  tokens_cache_write: 20_000,
  tokens_saved: 0,
  cost_usd: 9.75,
  wasted_usd: 1.2,
});
