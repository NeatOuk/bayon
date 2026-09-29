import { NO_STEP_TIERS } from "@bayon/core";
import {
  DEFAULT_JIRA_PUSH_VIEW,
  NO_DELIVERY,
  NO_DOCS,
  NO_QA,
} from "@bayon/proto";
import type {
  AgentSessionItem,
  AgentSessionsPage,
  ProjectAgentView,
  ProjectView,
  ProjectsView,
  TimelineEntry,
  TimelinePage,
} from "@bayon/proto";

// Wire-shaped project data: every value here would pass its proto schema.
// Runner ids are data: `fixture` is the one registered in every test install.

const T0 = 1_800_000_000_000;

export const projectView = (
  project: Partial<ProjectView> = {},
): ProjectView => ({
  id: "ws-bayon",
  name: "bayon",
  kind: "single",
  repos: [
    {
      id: "bayon",
      origin_url: "/src/bayon",
      push_url: null,
      rel_path: "bayon",
      submodule_path: null,
      default_base_branch: "main",
    },
  ],
  agents: [
    {
      id: "bayon-builder",
      name: "bayon-builder",
      kind: "builder",
      runner_id: "fixture",
      enabled: true,
      max_concurrency: 1,
      model: "model-mid",
      model_id: "fixture.standard",
    },
    {
      id: "bayon-reviewer",
      name: "bayon-reviewer",
      kind: "reviewer",
      runner_id: "fixture",
      enabled: false,
      max_concurrency: 1,
      model: null,
      model_id: null,
    },
  ],
  open_tickets: 3,
  paused: false,
  staff_approval: false,
  jira: null,
  qa: NO_QA,
  docs: NO_DOCS,
  delivery: NO_DELIVERY,
  jira_push: DEFAULT_JIRA_PUSH_VIEW,
  step_tiers: NO_STEP_TIERS,
  context_compression: false,
  ...project,
});

export const projectsView = (
  ...projects: readonly ProjectView[]
): ProjectsView => ({ projects: [...projects] });

export const timelineEntry = (
  entry: Partial<TimelineEntry> & Pick<TimelineEntry, "key" | "summary">,
): TimelineEntry => ({
  source: "ticket",
  ts: T0,
  kind: "ticket.transition",
  actor: "operator",
  agent_id: null,
  ticket_id: null,
  ticket_key: null,
  session_id: null,
  ...entry,
});

/** One page; a `nextCursor` means older ones follow. */
export const timelinePage = (
  items: readonly TimelineEntry[],
  nextCursor: string | null = null,
): TimelinePage => ({
  items: [...items],
  next_cursor: nextCursor,
  has_more: nextCursor !== null,
});

/** One of a project's agents; enabled, one slot. */
export const projectAgent = (
  agent: Partial<ProjectAgentView> & Pick<ProjectAgentView, "id">,
): ProjectAgentView => ({
  name: agent.id,
  kind: "builder",
  runner_id: "fixture",
  enabled: true,
  max_concurrency: 1,
  model: "model-mid",
  model_id: "fixture.standard",
  ...agent,
});

/** One of an agent's sessions, ended ok on no ticket. */
export const agentSessionItem = (
  item: Partial<AgentSessionItem> & Pick<AgentSessionItem, "id">,
): AgentSessionItem => ({
  ticket_id: null,
  ticket_key: null,
  role: "builder",
  run_class: "build",
  runner_id: "fixture",
  state: "exited",
  created_at: T0,
  started_at: T0 + 1_000,
  ended_at: T0 + 60_000,
  turns: 3,
  cost_usd: 0.25,
  exit_reason: "ok",
  ...item,
});

/** One page; a `nextCursor` means older ones follow. */
export const agentSessionsPage = (
  items: readonly AgentSessionItem[],
  nextCursor: string | null = null,
): AgentSessionsPage => ({
  items: [...items],
  next_cursor: nextCursor,
  has_more: nextCursor !== null,
});
