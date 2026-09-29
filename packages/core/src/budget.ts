import { z } from "zod";

// Budgets (§4, §13.4; M4 amendment): a spend cap on the fleet or on one agent, over a UTC day or
// month. What a budget has spent is computed from `spend` at read time over the window its period
// names, never stored, so a window rolls by itself.

/** What a budget caps: the whole fleet, or one agent's sessions. */
export const BudgetScope = z.enum(["fleet", "agent"]);
export type BudgetScope = z.infer<typeof BudgetScope>;

/** The window a budget counts: the UTC day or the UTC month holding now. */
export const BudgetPeriod = z.enum(["day", "month"]);
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

/** What a breach does. §13.4's `kill` is deferred past M4, so it is not a value here. */
export const BudgetOnBreach = z.enum(["warn", "pause_admission"]);
export type BudgetOnBreach = z.infer<typeof BudgetOnBreach>;

/** A budget's window in epoch millis, `start` inclusive and `end` exclusive. */
export interface BudgetWindow {
  readonly start: number;
  readonly end: number;
}

/** The UTC day or month that holds `now`. */
export function budgetWindow(period: BudgetPeriod, now: number): BudgetWindow {
  const at = new Date(now);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  if (period === "day") {
    const day = at.getUTCDate();
    return {
      start: Date.UTC(year, month, day),
      end: Date.UTC(year, month, day + 1),
    };
  }
  return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) };
}
