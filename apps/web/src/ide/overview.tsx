import type {
  AgentPulsesPage,
  FleetRow,
  ProjectAgentView,
  ProjectView,
} from "@bayon/proto";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  DescriptionItem,
  DescriptionList,
} from "@/components/description-list";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { humanize } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { STRETCHED_LINK, TextLink } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import { projectProposalsQuery, useProposalsFeed } from "@/ide/agents-api";
import { LiveState, Presence, type TabHref } from "@/ide/live-state";
import { ORCHESTRATOR } from "@/ide/orchestrator-api";
import { useProjectFleet } from "@/ide/project-fleet";
import { WaitingOnYou } from "@/ide/waiting-on-you";
import { pulseAgentsQuery } from "@/pulses/pulse-api";
import { describeNextPulse } from "@/pulses/pulse-model";
import { usePulsesFeed } from "@/pulses/use-pulses-feed";
import { projectHref, type IdeView } from "@/routing";
import { cn } from "@/lib/utils";
import { Panel } from "@/tickets/panel";
import { agentLine } from "@/lib/format";

// The IDE's Overview: the project's facts, what waits on the operator
//, its orchestrator's status, and a live roster of what each of its agents is doing. Read-only: every control is a link to a tab or
// another view (the orchestrator's are in the Orchestrator view).

const KIND_LABELS: Readonly<Record<ProjectView["kind"], string>> = {
  single: "single repo",
  multi: "multi-repo",
  submodule: "repo with submodules",
};

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const NO_ROWS: readonly FleetRow[] = [];

function Stat({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-3 shadow-xs">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-head text-2xl">{children}</dd>
    </div>
  );
}

/** The project at a glance: its facts, its orchestrator, and what each agent is doing now. */
export function OverviewView({
  project,
  view,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
}) {
  const { byAgent } = useProjectFleet(project.id);
  const tabHref: TabHref = (tab) => projectHref(project.id, view, tab);
  const enabled = project.agents.filter((agent) => agent.enabled).length;
  return (
    <PageContainer>
      <PageHeader
        title={project.name}
        meta={
          <>
            <Badge variant="outline">{KIND_LABELS[project.kind]}</Badge>
            {project.paused && <StatusBadge entity="pause" state="paused" />}
            {project.staff_approval && (
              <Badge variant="secondary">staffing waits for approval</Badge>
            )}
          </>
        }
      />
      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat label="Open tickets">
          <TextLink href={projectHref(project.id, "tickets")}>
            {project.open_tickets}
          </TextLink>
        </Stat>
        <Stat label="Agents">
          {project.agents.length}
          <span className="ml-2 text-sm text-muted-foreground">{`${enabled} enabled`}</span>
        </Stat>
        <Stat label="Repos">{project.repos.length}</Stat>
      </dl>
      <WaitingOnYou project={project} tabHref={tabHref} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <OrchestratorCard
          project={project}
          byAgent={byAgent}
          tabHref={tabHref}
        />
        <AgentRoster project={project} byAgent={byAgent} tabHref={tabHref} />
      </div>
      <Panel label="repos" title={plural(project.repos.length, "repo")}>
        <ul className="flex flex-col gap-1 text-sm">
          {project.repos.map((repo) => (
            <li key={repo.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono">
                {repo.submodule_path ?? repo.id}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {`${repo.default_base_branch} · ${repo.origin_url ?? "no origin"}`}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </PageContainer>
  );
}

interface CardProps {
  readonly project: ProjectView;
  readonly byAgent: ReadonlyMap<string, readonly FleetRow[]>;
  readonly tabHref: TabHref;
}

/**
 * The orchestrator's status, read-only: whether it is enabled and awake, its pulse
 * mode and next pulse, the project's hold, and the staffing proposals waiting on the operator.
 */
function OrchestratorCard({ project, byAgent, tabHref }: CardProps) {
  usePulsesFeed();
  useProposalsFeed(project.id);
  const pulses = useQuery(pulseAgentsQuery);
  const proposals = useQuery(projectProposalsQuery(project.id));
  const orchestrators = project.agents.filter(
    (agent) => agent.kind === ORCHESTRATOR,
  );
  return (
    <Panel label="orchestrator" title="Orchestrator">
      {orchestrators.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No orchestrator: only the operator staffs this project&apos;s tickets.
        </p>
      )}
      {orchestrators.map((agent) => {
        const live = byAgent.get(agent.name) ?? NO_ROWS;
        const [first] = live;
        return (
          <div key={agent.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <TextLink
                className="font-head"
                href={tabHref({ kind: "agent", id: agent.id })}
              >
                {agent.name}
              </TextLink>
              <StatusBadge
                entity="enabled"
                state={agent.enabled ? "enabled" : "disabled"}
              />
              <Presence live={first} />
            </div>
            <DescriptionList>
              <DescriptionItem term="Pulse">
                <PulseLine agent={agent} pulses={pulses} />
              </DescriptionItem>
            </DescriptionList>
          </div>
        );
      })}
      <DescriptionList>
        <DescriptionItem term="Project">
          {project.paused
            ? "paused: nothing new starts, and its orchestrator does not pulse"
            : "running"}
        </DescriptionItem>
        <DescriptionItem term="Staffing">
          {project.staff_approval
            ? "each proposal waits for the operator's approval"
            : "starts without asking"}
        </DescriptionItem>
        <DescriptionItem term="Proposals">
          {proposals.isPending && "loading…"}
          {proposals.isError && `unavailable: ${proposals.error.message}`}
          {proposals.data !== undefined && (
            <TextLink href={projectHref(project.id, "orchestrator")}>
              {proposals.data.items.length === 0
                ? "none open"
                : `${proposals.data.items.length}${proposals.data.has_more ? "+" : ""} open`}
            </TextLink>
          )}
        </DescriptionItem>
      </DescriptionList>
      <p className="text-xs text-muted-foreground">
        Read-only here: the Orchestrator view holds its controls and answers its
        proposals.
      </p>
    </Panel>
  );
}

function PulseLine({
  agent,
  pulses,
}: {
  readonly agent: ProjectAgentView;
  readonly pulses: UseQueryResult<AgentPulsesPage>;
}) {
  if (!agent.enabled) return <>does not pulse while disabled</>;
  if (pulses.isPending) return <>loading…</>;
  if (pulses.isError) return <>{`unavailable: ${pulses.error.message}`}</>;
  const policy = pulses.data?.items.find((item) => item.agent_id === agent.id);
  if (policy === undefined) return <>not scheduled</>;
  return (
    <>
      <Badge variant="outline" className="mr-2 align-text-bottom">
        {humanize(policy.mode)}
      </Badge>
      <span>{describeNextPulse(policy, pulses.dataUpdatedAt)}</span>
    </>
  );
}

/**
 * One row per agent: who it is, on which runner, and its live sessions, or idle or
 * disabled. The whole row opens the agent's tab (a stretched link); its ticket and session links
 * open theirs.
 */
function AgentRoster({ project, byAgent, tabHref }: CardProps) {
  return (
    <Panel label="agent roster" title="Agents, live">
      {project.agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agents yet: add one in the Agents view.
        </p>
      ) : (
        <ul aria-label="roster" className="flex flex-col gap-2">
          {project.agents.map((agent) => (
            <li
              key={agent.id}
              className="relative flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-md border p-2 hover:bg-accent"
            >
              <div className="flex min-w-0 flex-col">
                <a
                  href={tabHref({ kind: "agent", id: agent.id })}
                  className={cn("truncate font-head", STRETCHED_LINK)}
                >
                  {agent.name}
                </a>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {agentLine(agent)}
                </span>
              </div>
              <LiveState
                agent={agent}
                rows={byAgent.get(agent.name) ?? NO_ROWS}
                tabHref={tabHref}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
