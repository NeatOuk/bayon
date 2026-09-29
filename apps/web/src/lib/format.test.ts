import { expect, test } from "vitest";
import { formatLocalTime, relativeTime } from "@/lib/format";

test("formatLocalTime is the viewer's wall clock, to the second", () => {
  expect(formatLocalTime(new Date(2026, 8, 2, 7, 5, 9).getTime())).toBe(
    "2026-09-02 07:05:09",
  );
});

test.each([
  [0, "just now"],
  [59_999, "just now"],
  [-5_000, "just now"],
  [60_000, "1 min ago"],
  [59 * 60_000, "59 min ago"],
  [60 * 60_000, "1 h ago"],
  [23 * 3_600_000 + 59 * 60_000, "23 h ago"],
  [24 * 3_600_000, "1 d ago"],
  [400 * 24 * 3_600_000, "400 d ago"],
])("relativeTime %d ms before now is %j", (ago, text) => {
  const now = 1_800_000_000_000;
  expect(relativeTime(now - ago, now)).toBe(text);
});
