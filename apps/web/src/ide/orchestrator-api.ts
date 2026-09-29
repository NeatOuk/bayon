import type { AgentKind, StepTiers } from "@bayon/core";
import {
  ProjectPauseState,
  ProjectSettingsState,
  type DocsSource,
  type InboxPage,
  type ProjectAgentView,
  type DeliveryConfig,
  type QaConfig,
  type ProjectView,
  type ProjectsView,
} from "@bayon/proto";
import type { QueryClient } from "@tanstack/react-query";
import { patchJson, postJson } from "@/api/http";
import { PROJECTS_KEY } from "@/projects/projects-api";
import { pulseAgentsQuery } from "@/pulses/pulse-api";
import { projectSpendKey } from "@/spend/spend-api";

// The IDE's Orchestrator view's REST: the project's own hold (`POST /projects/:id/pause`
// and `/resume`) and its staffing approval (`PATCH /projects/:id`). The wake,
// the pulse policy, the proposals and the mission reuse the Pulses, Inbox and Missions calls.

const segment = encodeURIComponent;

/** `agents.kind` of the agent that pulses and staffs a project (core's project plan). */
export const ORCHESTRATOR = "orchestrator" satisfies AgentKind;

/**
 * The project's orchestrator: its enabled one (at most one is), else its first — a
 * disabled one the operator may re-enable or replace.
 */
export const orchestratorOf = (
  project: ProjectView,
): ProjectAgentView | undefined => {
  const all = project.agents.filter((agent) => agent.kind === ORCHESTRATOR);
  return all.find((agent) => agent.enabled) ?? all[0];
};

/** `POST /projects/:id/pause` or `/resume`; the same state again is `changed: false`. No body. */
export const setProjectPaused = (
  project: string,
  paused: boolean,
): Promise<ProjectPauseState> =>
  postJson(
    `/projects/${segment(project)}/${paused ? "pause" : "resume"}`,
    {},
    ProjectPauseState,
  );

/** `PATCH /projects/:id {staff_approval}`: whether the orchestrator's staffing waits for approval. */
export const setStaffApproval = (
  project: string,
  staffApproval: boolean,
): Promise<ProjectSettingsState> =>
  patchJson(
    `/projects/${segment(project)}`,
    { staff_approval: staffApproval },
    ProjectSettingsState,
  );

/** `PATCH /projects/:id {qa}`: the project's QA harness. `mode: "none"` turns it off;
 * `mode: "pending"` also files the ticket asking for one, whose key the answer carries. */
export const setProjectQa = (
  project: string,
  qa: QaConfig,
): Promise<ProjectSettingsState> =>
  patchJson(`/projects/${segment(project)}`, { qa }, ProjectSettingsState);

/** `PATCH /projects/:id {docs}`: where the project's documentation lives.
 * `kind: "none"` turns the reader off; a source with no site or account takes the Jira source's. */
export const setProjectDocs = (
  project: string,
  docs: DocsSource,
): Promise<ProjectSettingsState> =>
  patchJson(`/projects/${segment(project)}`, { docs }, ProjectSettingsState);

/** `PATCH /projects/:id {delivery}`: where the project's finished work goes. Anything
 * but `mode: "none"` is the operator's standing approval for Bayon to write to its remote (§14). */
export const setProjectDelivery = (
  project: string,
  delivery: DeliveryConfig,
): Promise<ProjectSettingsState> =>
  patchJson(
    `/projects/${segment(project)}`,
    { delivery },
    ProjectSettingsState,
  );

/** `PATCH /projects/:id {step_tiers}`: the tier each step of its work runs, null inherits. */
export const setProjectStepTiers = (
  project: string,
  stepTiers: StepTiers,
): Promise<ProjectSettingsState> =>
  patchJson(
    `/projects/${segment(project)}`,
    { step_tiers: stepTiers },
    ProjectSettingsState,
  );

/**
 * `PATCH /projects/:id {context_compression}`: whether the sessions spawned from now on
 * run their model calls through the context proxy, each on a compression-on certificate.
 */
export const setProjectContextCompression = (
  project: string,
  on: boolean,
): Promise<ProjectSettingsState> =>
  patchJson(
    `/projects/${segment(project)}`,
    { context_compression: on },
    ProjectSettingsState,
  );

/** What a project write changed, as the server answered it (its Jira source; its QA
 * harness; its documentation source; its delivery; its repos'
 * push targets: 039; what goes back to Jira; context compression). */
export type ProjectChange = Partial<
  Pick<
    ProjectView,
    | "paused"
    | "staff_approval"
    | "jira"
    | "qa"
    | "docs"
    | "delivery"
    | "repos"
    | "jira_push"
    | "step_tiers"
    | "context_compression"
  >
>;

/** `projects` with `project` changed as the server now has it. */
export const withProjectChange = (
  projects: ProjectsView,
  project: string,
  change: ProjectChange,
): ProjectsView => ({
  projects: projects.projects.map((known) =>
    known.id === project ? { ...known, ...change } : known,
  ),
});

/**
 * After a project write: show the server's answer at once, then refetch what it changes — the
 * projects (the header's badge, the Overview) and the pulse schedule (a paused project's
 * orchestrator does not pulse), and its Spend (a paused project reports no drop).
 */
export async function afterProjectWrite(
  queryClient: QueryClient,
  project: string,
  change: ProjectChange,
): Promise<void> {
  queryClient.setQueryData<ProjectsView>(PROJECTS_KEY, (known) =>
    known === undefined ? undefined : withProjectChange(known, project, change),
  );
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
    queryClient.invalidateQueries({ queryKey: pulseAgentsQuery.queryKey }),
    // Its Spend reports a drop only while it is not paused.
    queryClient.invalidateQueries({ queryKey: projectSpendKey(project) }),
  ]);
}

/** `page` without the request `id`: an answered proposal leaves the open list at once. */
export const withoutRequest = (page: InboxPage, id: string): InboxPage => ({
  ...page,
  items: page.items.filter((item) => item.id !== id),
});
