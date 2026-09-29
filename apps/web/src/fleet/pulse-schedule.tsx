import type { AgentPulse, ProjectView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { Loading } from "@/components/loading";
import { SectionTitle } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { humanize } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
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
import { projectsQuery } from "@/projects/projects-api";
import { pulseAgentsQuery } from "@/pulses/pulse-api";
import { nextPulseCell } from "@/pulses/pulse-model";
import { RunNowButton } from "@/pulses/run-now-button";
import { usePulsesFeed } from "@/pulses/use-pulses-feed";
import { PROJECTS_HREF, PULSES_HREF } from "@/routing";

// §12.3 FLEET's pulse schedule: each orchestrator, its mode, its next pulse, and Run
// now as a quiet button. While the fleet or the agent's project is paused nothing pulses, so the row
// says so and Run now is disabled with the reason — the server refuses it the same way.

/** Why `agent` cannot pulse now, or null: the fleet's pause first, then its project's. */
export function pulseBlock(
  agent: Pick<AgentPulse, "agent_id">,
  fleetPaused: boolean,
  projects: readonly ProjectView[],
): { readonly label: string; readonly why: string } | null {
  if (fleetPaused)
    return {
      label: "Fleet paused",
      why: "The fleet is paused: resume it to run a pulse.",
    };
  const project = projects.find((p) =>
    p.agents.some((a) => a.id === agent.agent_id),
  );
  if (project?.paused === true)
    return {
      label: "Project paused",
      why: `${project.name} is paused: resume it to run a pulse.`,
    };
  return null;
}

export function PulseSchedule({
  fleetPaused,
}: {
  readonly fleetPaused: boolean;
}) {
  usePulsesFeed();
  const agents = useQuery(pulseAgentsQuery);
  // Only for the project pause: a failed read leaves the fleet's own pause, and the server, to say it.
  const projects = useQuery(projectsQuery);
  return (
    <section aria-label="pulses" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <SectionTitle>Pulse schedule</SectionTitle>
        <TextLink href={PULSES_HREF} className="text-sm">
          Every pulse
        </TextLink>
      </div>
      {agents.isPending && <Loading label="Loading the pulse schedule…" />}
      {agents.isError && (
        <QueryError
          title="The pulse schedule is unavailable"
          error={agents.error}
          onRetry={() => void agents.refetch()}
        />
      )}
      {agents.data?.items.length === 0 && (
        <Empty className="py-5">
          <EmptyHeader>
            <EmptyTitle>No orchestrator pulses</EmptyTitle>
            <EmptyDescription>
              An enabled orchestrator wakes on its schedule to staff and steer
              its project. Add one from a project&apos;s Orchestrator view.
            </EmptyDescription>
          </EmptyHeader>
          <TextLink href={PROJECTS_HREF}>Open the projects</TextLink>
        </Empty>
      )}
      {agents.data !== undefined && agents.data.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Orchestrator</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Next pulse</TableHead>
              <TableHead>
                <span className="sr-only">Run now</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.data.items.map((agent) => {
              const next = nextPulseCell(agent, agents.dataUpdatedAt);
              const block = pulseBlock(
                agent,
                fleetPaused,
                projects.data?.projects ?? [],
              );
              return (
                <TableRow key={agent.agent_id}>
                  <TableCell className="font-medium">
                    <TextLink href={PULSES_HREF}>{agent.name}</TextLink>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" tone="neutral">
                      {humanize(agent.mode)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {block === null ? (
                      <span
                        title={next.title}
                        className="tabular-nums"
                        data-testid="next-pulse"
                      >
                        {next.text}
                      </span>
                    ) : (
                      <StatusBadge
                        entity="pause"
                        state="paused"
                        label={block.label}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <RunNowButton
                      agentId={agent.agent_id}
                      agentName={agent.name}
                      variant="ghost"
                      blocked={block?.why ?? null}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
