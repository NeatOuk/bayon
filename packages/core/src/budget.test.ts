import { expect, test } from "vitest";
import {
  BudgetOnBreach,
  BudgetPeriod,
  BudgetScope,
  budgetWindow,
} from "./budget.js";

const at = (iso: string): number => Date.parse(iso);

const WINDOWS: readonly (readonly [
  string,
  BudgetPeriod,
  string,
  string,
  string,
])[] = [
  [
    "a day, mid-day",
    "day",
    "2026-09-14T13:45:00.000Z",
    "2026-09-14",
    "2026-09-15",
  ],
  [
    "a day, at midnight",
    "day",
    "2026-09-14T00:00:00.000Z",
    "2026-09-14",
    "2026-09-15",
  ],
  [
    "a day, its last millisecond",
    "day",
    "2026-09-14T23:59:59.999Z",
    "2026-09-14",
    "2026-09-15",
  ],
  [
    "a day, across the year",
    "day",
    "2026-12-31T08:00:00.000Z",
    "2026-12-31",
    "2027-01-01",
  ],
  [
    "a month, mid-month",
    "month",
    "2026-09-14T13:45:00.000Z",
    "2026-09-01",
    "2026-10-01",
  ],
  [
    "a month, its first millisecond",
    "month",
    "2026-09-01T00:00:00.000Z",
    "2026-09-01",
    "2026-10-01",
  ],
  [
    "a month, December",
    "month",
    "2026-12-31T23:59:59.999Z",
    "2026-12-01",
    "2027-01-01",
  ],
  [
    "a month, a leap February",
    "month",
    "2028-02-29T12:00:00.000Z",
    "2028-02-01",
    "2028-03-01",
  ],
];

test.each(WINDOWS)("budgetWindow: %s", (_, period, now, start, end) => {
  expect(budgetWindow(period, at(now))).toEqual({
    start: at(`${start}T00:00:00.000Z`),
    end: at(`${end}T00:00:00.000Z`),
  });
});

test("scope is fleet or agent, period day or month, and a breach never kills (deferred past M4)", () => {
  expect(BudgetScope.options).toEqual(["fleet", "agent"]);
  expect(BudgetPeriod.options).toEqual(["day", "month"]);
  expect(BudgetOnBreach.options).toEqual(["warn", "pause_admission"]);
  expect(BudgetOnBreach.safeParse("kill").success).toBe(false);
});
