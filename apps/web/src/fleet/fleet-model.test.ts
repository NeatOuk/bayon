import { expect, test } from "vitest";
import { budgetShare, formatIdle, formatUsd } from "@/fleet/fleet-model";

test("formatIdle", () => {
  expect(formatIdle(null)).toBe("—");
  expect(formatIdle(5_000)).toBe("5s");
  expect(formatIdle(3 * 60_000)).toBe("3m");
  expect(formatIdle(64 * 60_000)).toBe("1h 4m");
});

test("formatUsd", () => {
  expect(formatUsd(1.2)).toBe("$1.20");
  expect(formatUsd(0)).toBe("$0.00");
});

test("budgetShare", () => {
  expect(budgetShare(10, 40)).toEqual({ percent: 25, over: false });
  expect(budgetShare(50, 40)).toEqual({ percent: 100, over: true });
  expect(budgetShare(0, 0)).toEqual({ percent: 0, over: false });
  expect(budgetShare(1, 0)).toEqual({ percent: 100, over: true });
});
