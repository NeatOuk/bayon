import type { AgentPulse } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { humanize, pulseStatus } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatIdle, formatUsd } from "@/fleet/fleet-model";
import { formatTime } from "@/lib/format";
import { PolicyEditor } from "@/pulses/policy-editor";
import { pulseAgentsQuery, pulsesQuery } from "@/pulses/pulse-api";
import { describeNextPulse, firstLine } from "@/pulses/pulse-model";
import { RunNowButton } from "@/pulses/run-now-button";
import { usePulsesFeed } from "@/pulses/use-pulses-feed";
import { FLEET_HREF, pulseHref } from "@/routing";
import { Panel } from "@/tickets/panel";

/** §2 Pulses: each orchestrator's schedule and policy, then every pulse, newest first, live. */
export function PulsesScreen() {
  usePulsesFeed();
  const agents = useQuery(pulseAgentsQuery);
  const names = new Map(
    (agents.data?.items ?? []).map((agent) => [agent.agent_id, agent.name]),
  );
  return (
    <PageContainer>
      <PageHeader title="Pulses" />
      <Panel label="orchestrators" title="Orchestrators">
        {agents.isPending && <Loading label="Loading the orchestrators…" />}
        {agents.isError && (
          <QueryError
            title="The orchestrators are unavailable"
            error={agents.error}
            onRetry={() => void agents.refetch()}
          />
        )}
        {agents.data?.items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No enabled orchestrator: nothing pulses.
          </p>
        )}
        {agents.data?.items.map((agent) => (
          <OrchestratorRow
            key={agent.agent_id}
            agent={agent}
            now={agents.dataUpdatedAt}
          />
        ))}
      </Panel>
      <PulseList names={names} />
    </PageContainer>
  );
}

function OrchestratorRow({
  agent,
  now,
}: {
  readonly agent: AgentPulse;
  readonly now: number;
}) {
  return (
    <div
      role="group"
      aria-label={`orchestrator ${agent.name}`}
      className="flex flex-wrap items-center gap-3 text-sm"
    >
      <strong className="font-head">{agent.name}</strong>
      <Badge variant="outline">{humanize(agent.mode)}</Badge>
      <span>{describeNextPulse(agent, now)}</span>
      <span className="text-muted-foreground">
        {`every ${formatIdle(agent.interval_ms)} · gap ${formatIdle(agent.min_gap_ms)} · at most ${agent.max_per_hour}/h`}
      </span>
      <RunNowButton agentId={agent.agent_id} agentName={agent.name} />
      <PolicyEditor agent={agent} />
    </div>
  );
}

function PulseList({ names }: { readonly names: ReadonlyMap<string, string> }) {
  const pulses = useQuery(pulsesQuery);
  if (pulses.isPending)
    return <Loading label="Loading the pulses…" lines={3} />;
  if (pulses.isError)
    return (
      <QueryError
        title="The pulses are unavailable"
        error={pulses.error}
        onRetry={() => void pulses.refetch()}
      />
    );
  if (pulses.data.items.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No pulses yet</EmptyTitle>
          <EmptyDescription>
            The scheduler records every pulse here, skipped ones too.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <TextLink href={FLEET_HREF}>See the schedule on the Fleet</TextLink>
        </EmptyContent>
      </Empty>
    );
  return (
    <Panel label="pulse list" title="Every pulse">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>scheduled (UTC)</TableHead>
            <TableHead>agent</TableHead>
            <TableHead>trigger</TableHead>
            <TableHead>state</TableHead>
            <TableHead>context tokens</TableHead>
            <TableHead>cost</TableHead>
            <TableHead>summary</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pulses.data.items.map((pulse) => (
            <TableRow key={pulse.id}>
              <TableCell>
                <TextLink href={pulseHref(pulse.id)}>
                  {formatTime(pulse.scheduled_at)}
                </TextLink>
              </TableCell>
              <TableCell>
                {names.get(pulse.agent_id) ?? pulse.agent_id}
              </TableCell>
              <TableCell>{pulse.trigger}</TableCell>
              <TableCell>
                <StatusBadge status={pulseStatus(pulse)} />
              </TableCell>
              <TableCell>
                {pulse.context_tokens?.toLocaleString("en") ?? "—"}
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
    </Panel>
  );
}
