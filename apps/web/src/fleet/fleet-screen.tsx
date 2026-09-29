import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { BudgetBanner } from "@/fleet/budget-banner";
import { FleetStats } from "@/fleet/fleet-stats";
import { NeedsYou } from "@/fleet/needs-you";
import { PulseSchedule } from "@/fleet/pulse-schedule";
import { SessionCard } from "@/fleet/session-card";
import { useFleet } from "@/fleet/use-fleet";
import { TICKETS_HREF } from "@/routing";

/**
 * §12.3 FLEET, the 10-second glance (§12.4 #1), in the order the operator reads it:
 * what needs them, the figures, a budget near its cap, the pulse schedule, then the live sessions.
 */
export function FleetScreen() {
  const fleet = useFleet();
  if (fleet.isPending)
    return (
      <PageContainer>
        <Loading label="Loading the fleet…" lines={3} />
      </PageContainer>
    );
  if (fleet.isError)
    return (
      <PageContainer>
        <QueryError
          title="The fleet is unavailable"
          error={fleet.error}
          onRetry={() => void fleet.refetch()}
        />
      </PageContainer>
    );

  const { sessions, budgets, attention, paused, runner_updates } = fleet.data;
  const staleIds = new Set(
    attention.filter((a) => a.why === "stale").map((a) => a.session_id),
  );
  return (
    <PageContainer>
      <PageHeader title="Fleet" />
      {/* Ages are measured from the snapshot's arrival, so rendering stays pure. */}
      <NeedsYou
        items={attention}
        runnerUpdates={runner_updates}
        now={fleet.dataUpdatedAt}
      />
      <FleetStats fleet={fleet.data} />
      <BudgetBanner budgets={budgets} />
      <PulseSchedule fleetPaused={paused} />
      <section aria-label="live sessions" className="flex flex-col gap-2">
        <SectionTitle>Live sessions</SectionTitle>
        {sessions.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyTitle>No live sessions</EmptyTitle>
              <EmptyDescription>
                A session starts when a ticket is staffed or an orchestrator
                pulses; it shows here while it runs.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <a
                href={TICKETS_HREF}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Open the Tickets board
              </a>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
            {sessions.map((row) => (
              <SessionCard
                key={row.id}
                row={row}
                stale={staleIds.has(row.id)}
              />
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}
