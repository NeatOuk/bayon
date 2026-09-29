import type { Fleet } from "@bayon/proto";
import { StatCard, StatRow } from "@/components/stat-card";
import { humanize, labelOf } from "@/components/status";
import { BudgetStat } from "@/fleet/budget-bar";

// The Fleet's figures at a glance (§12.4 #1): today's spend, the slots in use, the live sessions,
// and what admission holds back. Every figure is the server's; this only lays them out.

/** "2 running · 1 idle": the live sessions by state, most first. */
export function sessionsByState(fleet: Pick<Fleet, "sessions">): string {
  const counts = new Map<string, number>();
  for (const s of fleet.sessions)
    counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
  return [...counts]
    .sort(([, a], [, b]) => b - a)
    .map(([state, n]) => `${n} ${labelOf("session", state).toLowerCase()}`)
    .join(" · ");
}

export function FleetStats({ fleet }: { readonly fleet: Fleet }) {
  const busy = fleet.slots.reduce((sum, s) => sum + s.busy, 0);
  const capacity = fleet.slots.reduce((sum, s) => sum + s.capacity, 0);
  const queued = fleet.admission.queued.length;
  return (
    <StatRow>
      <BudgetStat
        spentUsd={fleet.budget.today_usd}
        capUsd={fleet.budget.daily_cap_usd}
      />
      <StatCard
        label="Slots in use"
        value={
          fleet.slots.length === 0 ? (
            "—"
          ) : (
            <>
              {busy}
              <span className="text-sm font-normal text-muted-foreground">
                {` of ${capacity}`}
              </span>
            </>
          )
        }
        detail={
          fleet.slots.length === 0
            ? "No enabled executor"
            : fleet.slots
                .map((s) => `${s.executor_id} ${s.busy}/${s.capacity}`)
                .join(" · ")
        }
      />
      <StatCard
        label="Live sessions"
        value={fleet.sessions.length}
        detail={
          fleet.sessions.length === 0 ? "None running" : sessionsByState(fleet)
        }
      />
      {queued > 0 && (
        <StatCard
          label="Queued by admission"
          value={queued}
          detail={Object.entries(fleet.admission.by_reason)
            .map(([reason, n]) => `${n} ${humanize(reason).toLowerCase()}`)
            .join(" · ")}
        />
      )}
    </StatRow>
  );
}
