// Formatting for the Fleet. The figures themselves (budget, slots, attention) come from the server.
import type { BudgetView } from "@bayon/proto";

export function formatIdle(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

/** How much of the daily cap is spent, capped at 100 %. */
export function budgetShare(
  spentUsd: number,
  capUsd: number,
): { readonly percent: number; readonly over: boolean } {
  if (capUsd <= 0)
    return { percent: spentUsd > 0 ? 100 : 0, over: spentUsd > 0 };
  return {
    percent: Math.min(100, (spentUsd / capUsd) * 100),
    over: spentUsd > capUsd,
  };
}

/** How far into its cap a budget is, by whichever of its two caps is further along. */
function budgetUsedPct(b: BudgetView): number {
  const usd = b.cap_usd === null ? 0 : share(b.spent_usd, b.cap_usd);
  const tokens =
    b.cap_tokens === null ? 0 : share(b.spent_tokens, b.cap_tokens);
  return Math.max(usd, tokens);
}

const share = (spent: number, cap: number): number =>
  cap <= 0 ? (spent > 0 ? 100 : 0) : (spent / cap) * 100;

/** A budget at or past its own `warn_pct` (§13.4), and whether it is already at its cap. */
export interface BudgetAlert {
  readonly budget: BudgetView;
  readonly usedPct: number;
  /** At or over the cap: `pause_admission` budgets are holding spawns back here. */
  readonly breached: boolean;
}

/**
 * Which budgets have reached their warn threshold, the fullest first. The threshold is each
 * budget's own `warn_pct` column (§13.4's warn at 70 % is its default), never a constant here.
 */
export function budgetAlerts(
  budgets: readonly BudgetView[],
): readonly BudgetAlert[] {
  return budgets
    .map((budget) => {
      const usedPct = budgetUsedPct(budget);
      return { budget, usedPct, breached: usedPct >= 100 };
    })
    .filter((a) => a.usedPct >= a.budget.warn_pct)
    .sort((a, b) => b.usedPct - a.usedPct);
}

/** What a budget caps, for a banner: `the fleet` or the agent it names. */
export const budgetWhose = (b: BudgetView): string =>
  b.scope === "fleet" ? "the fleet" : (b.scope_ref ?? "an agent");
