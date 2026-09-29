import { describe, expect, test } from "vitest";
import { SpendQuery, SpendReport, SpendSummary } from "./spend.js";

const quiet = {
  daily_usd: 0,
  baseline_daily_usd: null,
  change_pct: null,
  alarm: false,
  drop: false,
};

const summary = {
  window: { from: 0, to: 1_000 },
  total_usd: 2,
  wasted_usd: 1,
  waste_pct: 50,
  burn: { today_usd: 2, month_to_date_usd: 2, projected_month_usd: 60 },
  alarm: {
    threshold_pct: 25,
    baseline_days: 30,
    last_day: quiet,
    last_7d: quiet,
    active: false,
    paused: false,
    dropped: false,
  },
};

describe("SpendQuery", () => {
  test("group defaults to day and takes the four groupings", () => {
    expect(SpendQuery.parse({})).toEqual({ group: "day" });
    for (const group of ["ticket", "tier", "class", "day"]) {
      expect(SpendQuery.parse({ group })).toEqual({ group });
    }
  });

  test("any other group is rejected", () => {
    for (const group of ["phase", "model", "", 1]) {
      expect(SpendQuery.safeParse({ group }).success).toBe(false);
    }
  });
});

describe("SpendReport", () => {
  test("rows are checked against their group", () => {
    const day = {
      day: 0,
      runs: 0,
      cost_usd: 0,
      wasted_usd: 0,
      tokens_saved: 0,
    };
    const report = { group: "day", summary, rows: [day] };
    expect(SpendReport.parse(report)).toEqual(report);
    expect(
      SpendReport.safeParse({ group: "tier", summary, rows: [day] }).success,
    ).toBe(false);
  });

  test("a tier row needs at least one closed ticket", () => {
    const tier = {
      tier: "standard",
      closed_tickets: 0,
      cost_p50_usd: 0,
      cost_p95_usd: 0,
      cost_total_usd: 0,
      review_rounds_avg: 0,
      handoffs_avg: 0,
    };
    expect(
      SpendReport.safeParse({ group: "tier", summary, rows: [tier] }).success,
    ).toBe(false);
    expect(
      SpendReport.safeParse({
        group: "tier",
        summary,
        rows: [{ ...tier, closed_tickets: 1 }],
      }).success,
    ).toBe(true);
  });

  test("a move must say whether it dropped, and the alarm whether it is paused", () => {
    const without = <T extends object>(o: T, key: keyof T) =>
      Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
    expect(
      SpendSummary.safeParse({
        ...summary,
        alarm: { ...summary.alarm, last_day: without(quiet, "drop") },
      }).success,
    ).toBe(false);
    for (const key of ["paused", "dropped"] as const) {
      expect(
        SpendSummary.safeParse({
          ...summary,
          alarm: without(summary.alarm, key),
        }).success,
      ).toBe(false);
    }
  });

  test("a negative cost or a zero threshold is rejected", () => {
    expect(SpendSummary.safeParse({ ...summary, total_usd: -1 }).success).toBe(
      false,
    );
    expect(
      SpendSummary.safeParse({
        ...summary,
        alarm: { ...summary.alarm, threshold_pct: 0 },
      }).success,
    ).toBe(false);
  });
});
