import { describe, expect, test } from "vitest";
import {
  DAY_MS,
  baselineSpanDays,
  burnMove,
  dayStart,
  monthOf,
  percentile,
  projectMonth,
  ratioPct,
} from "./spend-math.js";

describe("percentile (nearest rank)", () => {
  test("no values: null", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  test("one value is every percentile", () => {
    expect(percentile([7], 1)).toBe(7);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([7], 100)).toBe(7);
  });

  test("p50 of an even count is the lower middle, never an average", () => {
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
  });

  test("p50 of an odd count is the middle", () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
  });

  test("p95: rank ceil(0.95 n)", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred.slice(0, 20), 95)).toBe(19);
    // Below 20 values, rank ceil(0.95 n) is n: p95 is the maximum.
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  test("ties and out-of-range p clamp to an observed value", () => {
    expect(percentile([2, 2, 2, 9], 50)).toBe(2);
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 150)).toBe(3);
  });

  test("the input is not sorted in place", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

test("ratioPct: part of total, null for a zero total", () => {
  expect(ratioPct(1, 4)).toBe(25);
  expect(ratioPct(0, 4)).toBe(0);
  expect(ratioPct(0, 0)).toBeNull();
});

describe("baselineSpanDays", () => {
  const windowStart = 100 * DAY_MS;

  test("no history, or none before the window: no baseline", () => {
    expect(
      baselineSpanDays({ windowStart, baselineDays: 30, firstTs: null }),
    ).toBe(0);
    expect(
      baselineSpanDays({
        windowStart,
        baselineDays: 30,
        firstTs: windowStart + 1,
      }),
    ).toBe(0);
  });

  test("a long history is capped at baselineDays", () => {
    expect(
      baselineSpanDays({ windowStart, baselineDays: 30, firstTs: 0 }),
    ).toBe(30);
  });

  test("a short history counts whole days, rounded up, at least one", () => {
    expect(
      baselineSpanDays({
        windowStart,
        baselineDays: 30,
        firstTs: windowStart - 60_000,
      }),
    ).toBe(1);
    expect(
      baselineSpanDays({ windowStart, baselineDays: 30, firstTs: windowStart }),
    ).toBe(1);
    expect(
      baselineSpanDays({
        windowStart,
        baselineDays: 30,
        firstTs: windowStart - 4.5 * DAY_MS,
      }),
    ).toBe(5);
  });
});

describe("burnMove", () => {
  const move = (windowUsd: number, baselineUsd: number, baselineDays = 10) =>
    burnMove({
      windowUsd,
      windowDays: 1,
      baselineUsd,
      baselineDays,
      alarmPct: 25,
    });

  test("exactly the threshold does not alarm, either way", () => {
    expect(move(12.5, 100)).toEqual({
      daily_usd: 12.5,
      baseline_daily_usd: 10,
      change_pct: 25,
      alarm: false,
      drop: false,
    });
    expect(move(7.5, 100)).toMatchObject({
      change_pct: -25,
      alarm: false,
      drop: false,
    });
  });

  test("a rise past the threshold alarms; it is not a drop", () => {
    expect(move(12.6, 100)).toMatchObject({ alarm: true, drop: false });
    expect(move(12.6, 100).change_pct).toBeCloseTo(26);
  });

  test("a fall past the threshold is a drop, never an alarm", () => {
    expect(move(7.4, 100)).toMatchObject({ alarm: false, drop: true });
    expect(move(7.4, 100).change_pct).toBeCloseTo(-26);
    expect(move(0, 100)).toMatchObject({
      change_pct: -100,
      alarm: false,
      drop: true,
    });
  });

  test("within the threshold does not alarm", () => {
    expect(move(11, 100)).toMatchObject({ alarm: false, drop: false });
    expect(move(11, 100).change_pct).toBeCloseTo(10);
  });

  test("no baseline, or a zero one: no change and no alarm", () => {
    expect(move(50, 0, 0)).toEqual({
      daily_usd: 50,
      baseline_daily_usd: null,
      change_pct: null,
      alarm: false,
      drop: false,
    });
    expect(move(50, 0, 10)).toMatchObject({
      baseline_daily_usd: 0,
      change_pct: null,
      alarm: false,
      drop: false,
    });
  });

  test("a multi-day window compares daily means", () => {
    const m = burnMove({
      windowUsd: 70,
      windowDays: 7,
      baselineUsd: 300,
      baselineDays: 30,
      alarmPct: 25,
    });
    expect(m).toEqual({
      daily_usd: 10,
      baseline_daily_usd: 10,
      change_pct: 0,
      alarm: false,
      drop: false,
    });
  });
});

describe("month projection (UTC)", () => {
  test("monthOf spans the calendar month, leap February included", () => {
    const now = Date.UTC(2028, 1, 10, 12);
    expect(monthOf(now)).toEqual({
      start: Date.UTC(2028, 1, 1),
      end: Date.UTC(2028, 2, 1),
    });
    expect((monthOf(now).end - monthOf(now).start) / DAY_MS).toBe(29);
    expect(monthOf(Date.UTC(2026, 11, 31, 23)).end).toBe(Date.UTC(2027, 0, 1));
  });

  test("a straight line through month-to-date", () => {
    // 10 of September's 30 days gone, $20 spent: $60 by the end.
    expect(projectMonth(Date.UTC(2026, 8, 11), 20)).toBeCloseTo(60);
    expect(projectMonth(Date.UTC(2026, 8, 11), 0)).toBe(0);
  });

  test("at the month's first instant the projection is the month-to-date", () => {
    expect(projectMonth(Date.UTC(2026, 8, 1), 0)).toBe(0);
    expect(projectMonth(Date.UTC(2026, 8, 1), 3)).toBe(3);
  });
});

test("dayStart is UTC midnight", () => {
  expect(dayStart(Date.UTC(2026, 8, 13, 17, 5))).toBe(Date.UTC(2026, 8, 13));
  expect(dayStart(Date.UTC(2026, 8, 13))).toBe(Date.UTC(2026, 8, 13));
});
