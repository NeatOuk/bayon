// The arithmetic behind the spend roll-ups (§8.9): percentiles, a burn move against its baseline,
// and the straight-line month projection. Pure, so every edge case is a unit test. Times are
// epoch millis, and days are UTC.

export const DAY_MS = 24 * 60 * 60_000;

/**
 * The nearest-rank percentile. Sort ascending and take the value at 1-based rank ceil(p/100 × n),
 * clamped to [1, n]. The answer is always an observed value, with no interpolation, so the same
 * rows give the same answer everywhere. Null for no values. `values` is not modified.
 */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil((p / 100) * sorted.length)),
  );
  return sorted[rank - 1] ?? null;
}

/** part ÷ total × 100, or null when the total is zero. */
export const ratioPct = (part: number, total: number): number | null =>
  total === 0 ? null : (part / total) * 100;

/** One window's burn against the baseline before it. */
export interface BurnMove {
  /** Mean daily spend over the window. */
  readonly daily_usd: number;
  /** Mean daily spend over the baseline; null when there is no history before the window. */
  readonly baseline_daily_usd: number | null;
  /** (daily − baseline) ÷ baseline × 100. Null without a baseline, or when it is zero. */
  readonly change_pct: number | null;
  /**
   * Burn rose more than the threshold (a rise only; exactly the threshold is quiet).
   * A fall is `drop`, never an alarm: spending less is not an emergency.
   */
  readonly alarm: boolean;
  /** Burn fell more than the threshold: news, not an alarm. */
  readonly drop: boolean;
}

/**
 * The days of baseline a window can have: `baselineDays`, or fewer when history started later.
 * Whole days, rounded up, so a first spend just before the window does not make a baseline of
 * a few minutes. 0 when nothing was spent before the window.
 */
export function baselineSpanDays(o: {
  readonly windowStart: number;
  readonly baselineDays: number;
  readonly firstTs: number | null;
}): number {
  if (o.firstTs === null || o.firstTs > o.windowStart) return 0;
  const history = Math.ceil((o.windowStart - o.firstTs) / DAY_MS);
  return Math.min(o.baselineDays, Math.max(1, history));
}

export function burnMove(o: {
  readonly windowUsd: number;
  readonly windowDays: number;
  readonly baselineUsd: number;
  /** From baselineSpanDays; 0 means there is no baseline. */
  readonly baselineDays: number;
  readonly alarmPct: number;
}): BurnMove {
  const daily = o.windowUsd / o.windowDays;
  const baseline = o.baselineDays > 0 ? o.baselineUsd / o.baselineDays : null;
  const change =
    baseline === null || baseline === 0
      ? null
      : ((daily - baseline) / baseline) * 100;
  return {
    daily_usd: daily,
    baseline_daily_usd: baseline,
    change_pct: change,
    alarm: change !== null && change > o.alarmPct,
    drop: change !== null && change < -o.alarmPct,
  };
}

/** The UTC calendar month holding `now`: [start, end). */
export function monthOf(now: number): {
  readonly start: number;
  readonly end: number;
} {
  const d = new Date(now);
  return {
    start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

/**
 * A straight line through the month so far: month-to-date ÷ time elapsed × the month's length.
 * At the month's first instant nothing has elapsed, so the projection is the month-to-date.
 */
export function projectMonth(now: number, monthToDateUsd: number): number {
  const { start, end } = monthOf(now);
  const elapsed = now - start;
  return elapsed <= 0
    ? monthToDateUsd
    : (monthToDateUsd * (end - start)) / elapsed;
}

/** The start of the UTC day holding `ts`. */
export const dayStart = (ts: number): number => ts - (ts % DAY_MS);
