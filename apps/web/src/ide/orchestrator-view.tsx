import type { FleetRow, ProjectAgentView, ProjectView } from "@bayon/proto";
import { Id } from "@/components/id";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { AddOrchestrator } from "@/ide/add-orchestrator";
import { Presence, type TabHref } from "@/ide/live-state";
import { orchestratorOf } from "@/ide/orchestrator-api";
import {
  ProjectPauseControl,
  ScheduleControl,
  StaffApprovalControl,
  WakeControl,
} from "@/ide/orchestrator-controls";
import { RecentPulses } from "@/ide/orchestrator-pulses";
import { useProjectFleet } from "@/ide/project-fleet";
import { ProposalsPanel } from "@/ide/proposals-panel";
import { MissionScreen } from "@/missions/mission-screen";
import { usePulsesFeed } from "@/pulses/use-pulses-feed";
import { projectHref, type IdeView } from "@/routing";
import { Panel } from "@/tickets/panel";

// The IDE's Orchestrator view: the control panel for the project's orchestrator. No chat
// input: every action is a control — the project's pause, its staffing approval, a pulse now, the
// pulse schedule, the proposals to answer, the mission — and every pulse's report opens as a tab.

const NO_ROWS: readonly FleetRow[] = [];

export function OrchestratorView({
  project,
  view,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
}) {
  usePulsesFeed();
  const orchestrator = orchestratorOf(project);
  const tabHref: TabHref = (tab) => projectHref(project.id, view, tab);
  return (
    <PageContainer>
      <header className="flex flex-col gap-2">
        <PageHeader title="Orchestrator" />
        {orchestrator === undefined ? (
          <NoOrchestrator project={project} />
        ) : (
          <OrchestratorFacts
            project={project.id}
            agent={orchestrator}
            tabHref={tabHref}
          />
        )}
      </header>
      <Panel label="controls" title="Controls">
        <div className="grid gap-3 md:grid-cols-2">
          <ProjectPauseControl project={project} />
          {orchestrator !== undefined && (
            <>
              <StaffApprovalControl project={project} />
              <WakeControl agent={orchestrator} />
              <ScheduleControl agent={orchestrator} project={project.id} />
            </>
          )}
        </div>
      </Panel>
      {orchestrator !== undefined && (
        <>
          <ProposalsPanel project={project} tabHref={tabHref} />
          <Panel label="mission" title="Mission">
            <MissionScreen agent={orchestrator.name} embedded />
          </Panel>
          <RecentPulses agent={orchestrator} tabHref={tabHref} />
        </>
      )}
    </PageContainer>
  );
}

/** Who the orchestrator is: its tab, its runner, whether it takes work, and whether it is awake. */
function OrchestratorFacts({
  project,
  agent,
  tabHref,
}: {
  readonly project: string;
  readonly agent: ProjectAgentView;
  readonly tabHref: TabHref;
}) {
  const { byAgent } = useProjectFleet(project);
  const [live] = byAgent.get(agent.name) ?? NO_ROWS;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <TextLink
        className="font-head text-base"
        href={tabHref({ kind: "agent", id: agent.id })}
      >
        {agent.name}
      </TextLink>
      <Id value={agent.runner_id} className="text-xs" />
      <StatusBadge
        entity="enabled"
        state={agent.enabled ? "enabled" : "disabled"}
      />
      <Presence live={live} />
    </div>
  );
}

/**
 * No orchestrator: say so, and add one here. Once the server has it, the projects are
 * refetched and the view renders its controls, proposals, mission and pulses in place of this.
 */
function NoOrchestrator({ project }: { readonly project: ProjectView }) {
  return (
    <Empty className="items-start text-left">
      <EmptyHeader className="items-start text-left">
        <EmptyTitle>This project has no orchestrator</EmptyTitle>
        <EmptyDescription>
          Nothing pulses it, and only you staff its tickets. Add one on a
          runner: it pulses this project alone, on the default schedule, and
          starts with no mission; write one in the editor that then appears.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="items-start">
        <AddOrchestrator project={project} />
      </EmptyContent>
    </Empty>
  );
}
