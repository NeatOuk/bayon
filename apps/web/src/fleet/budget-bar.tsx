import { StatCard } from "@/components/stat-card";
import { Progress } from "@/components/ui/progress";
import { BudgetCapDialog } from "@/fleet/budget-cap-dialog";
import { budgetShare, formatUsd } from "@/fleet/fleet-model";
import { cn } from "@/lib/utils";

/**
 * Today's spend against `settings.budget.daily_cap_usd` (amendment 8), as the Fleet's first stat:
 * the figure, the cap beside it, a bar (the danger tone once over it) and Edit cap. No bar when the
 * cap is null.
 */
export function BudgetStat({
  spentUsd,
  capUsd,
}: {
  readonly spentUsd: number;
  readonly capUsd: number | null;
}) {
  const share = capUsd === null ? null : budgetShare(spentUsd, capUsd);
  return (
    <StatCard
      label="Today's spend"
      action={<BudgetCapDialog capUsd={capUsd} />}
      value={
        <>
          {formatUsd(spentUsd)}
          {capUsd !== null && (
            <span className="text-sm font-normal text-muted-foreground">
              {` of ${formatUsd(capUsd)}`}
            </span>
          )}
        </>
      }
      detail={
        share === null
          ? "No daily cap"
          : share.over
            ? "Over the daily cap"
            : `${Math.floor(share.percent)}% of the daily cap`
      }
    >
      {share !== null && (
        <Progress
          aria-label="daily budget used"
          value={share.percent}
          className={cn(
            "mt-1 [&_[data-slot=progress-track]]:h-2",
            share.over && "[&_[data-slot=progress-indicator]]:bg-danger",
          )}
        />
      )}
    </StatCard>
  );
}
