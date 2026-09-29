import type { ProjectAgentView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { Loading } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { humanize, pulseStatus } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/fleet/fleet-model";
import type { TabHref } from "@/ide/live-state";
import { formatTime } from "@/lib/format";
import { RECENT_PULSES_LIMIT, agentPulsesQuery } from "@/pulses/pulse-api";
import { firstLine } from "@/pulses/pulse-model";
import { Panel } from "@/tickets/panel";

/**
 * The orchestrator's newest pulses, `GET /pulses?agent=`: when, why, how it went, what
 * it cost and the first line of its report. A pulse opens as a tab holding its whole report — the
 * summary, its actions and its probe checks — as the Pulses screen shows it. Live: the `pulses`
 * topic refetches the list.
 */
export function RecentPulses({
  agent,
  tabHref,
}: {
  readonly agent: ProjectAgentView;
  readonly tabHref: TabHref;
}) {
  const pulses = useQuery(agentPulsesQuery(agent.id));
  return (
    <Panel label="recent pulses" title="Recent pulses">
      {pulses.isPending && <Loading label="Loading the pulses…" />}
      {pulses.isError && (
        <QueryError
          title="The pulses are unavailable"
          error={pulses.error}
          onRetry={() => void pulses.refetch()}
        />
      )}
      {pulses.data?.items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No pulses yet: the scheduler records every one, skipped ones too.
        </p>
      )}
      {pulses.data !== undefined && pulses.data.items.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            {`The newest ${RECENT_PULSES_LIMIT} at most. A pulse opens its report as a tab.`}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>scheduled (UTC)</TableHead>
                <TableHead>trigger</TableHead>
                <TableHead>state</TableHead>
                <TableHead>cost</TableHead>
                <TableHead>summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pulses.data.items.map((pulse) => (
                <TableRow key={pulse.id}>
                  <TableCell>
                    <TextLink
                      href={tabHref({ kind: "pulse", id: pulse.id })}
                      title={pulse.id}
                    >
                      {formatTime(pulse.scheduled_at)}
                    </TextLink>
                  </TableCell>
                  <TableCell>{humanize(pulse.trigger)}</TableCell>
                  <TableCell>
                    <StatusBadge status={pulseStatus(pulse)} />
                  </TableCell>
                  <TableCell>
                    {pulse.cost_usd === null ? "—" : formatUsd(pulse.cost_usd)}
                  </TableCell>
                  <TableCell className="max-w-96 truncate">
                    {firstLine(pulse.summary_md)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </Panel>
  );
}
