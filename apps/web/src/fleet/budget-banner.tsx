import type { BudgetView } from "@bayon/proto";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  budgetAlerts,
  budgetWhose,
  formatUsd,
  type BudgetAlert,
} from "@/fleet/fleet-model";

// §13.4's warn: a budget at or past its own warn_pct says so on the Fleet, and one already at its
// cap says that instead — a `pause_admission` budget at its cap is why spawns are queueing. What
// each budget has spent is computed server-side at read time, so this clears itself when the
// window rolls or the operator raises the cap; nothing here needs to be dismissed.

/** One line per budget: whose it is, its window, and where its spend stands. */
function line(a: BudgetAlert): string {
  const b = a.budget;
  const spend =
    b.cap_usd === null
      ? `${a.budget.spent_tokens} of ${b.cap_tokens} tokens`
      : `${formatUsd(b.spent_usd)} of ${formatUsd(b.cap_usd)}`;
  return `${budgetWhose(b)} · ${b.period} · ${spend} (${Math.floor(a.usedPct)}%)`;
}

/** Nothing at all until a budget reaches its own warn threshold. */
export function BudgetBanner({
  budgets,
}: {
  readonly budgets: readonly BudgetView[];
}) {
  const alerts = budgetAlerts(budgets);
  if (alerts.length === 0) return null;
  const breached = alerts.filter((a) => a.breached);
  const paused = breached.some((a) => a.budget.on_breach === "pause_admission");
  return (
    <Alert
      aria-label="budget alert"
      status={breached.length > 0 ? "error" : "warning"}
    >
      <AlertTitle>
        {breached.length === 0
          ? "A budget is close to its cap"
          : paused
            ? "A budget is spent: new sessions are queued until it lifts"
            : "A budget is spent"}
      </AlertTitle>
      <AlertDescription>
        {alerts.map((a) => (
          <p key={a.budget.id}>{line(a)}</p>
        ))}
      </AlertDescription>
    </Alert>
  );
}
