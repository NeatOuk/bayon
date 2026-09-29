import { STAFF_APPROVAL_KIND } from "@bayon/core";
import {
  AgentSessionsPage,
  AgentView,
  InboxPage,
  type CreateProjectAgentRequest,
  type PatchAgentRequest,
  type ProjectsView,
} from "@bayon/proto";
import {
  infiniteQueryOptions,
  queryOptions,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { getJson, patchJson, postJson } from "@/api/http";
import { useFeed } from "@/feed/feed";
import { INBOX_KEY } from "@/inbox/inbox-api";
import { PROJECTS_KEY } from "@/projects/projects-api";
import { pulseAgentsQuery } from "@/pulses/pulse-api";

// The IDE's agent REST: a project's agents are added (`POST /projects/:id/agents`) and
// enabled, disabled or resized (`PATCH /agents/:id`); an agent's sessions are listed for
// replay (`GET /agents/:id/sessions`); a project's open staffing proposals are counted
// from the inbox (`GET /inbox?kind=staff_approval&project=`).

const segment = encodeURIComponent;

/** Every agent's session list: an agent write refreshes them by this prefix. */
export const AGENT_SESSIONS_KEY = ["agent-sessions"] as const;

/** Sessions per page of an agent's list; "Load older" fetches the next. */
export const AGENT_SESSIONS_LIMIT = 25;

const sessionsPath = (agentId: string, cursor: string | null): string => {
  const params = new URLSearchParams({ limit: String(AGENT_SESSIONS_LIMIT) });
  if (cursor !== null) params.set("cursor", cursor);
  return `/agents/${segment(agentId)}/sessions?${params.toString()}`;
};

/** `GET /agents/:id/sessions`, newest first, page after page on its keyset cursor. */
export const agentSessionsQuery = (agentId: string) =>
  infiniteQueryOptions({
    queryKey: [...AGENT_SESSIONS_KEY, agentId],
    queryFn: ({ pageParam, signal }) =>
      getJson(sessionsPath(agentId, pageParam), AgentSessionsPage, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
  });

/** `POST /projects/:id/agents`: 201 with the new agent; a 400/404/409 the dialog shows. */
export const addProjectAgent = (
  project: string,
  request: CreateProjectAgentRequest,
): Promise<AgentView> =>
  postJson(`/projects/${segment(project)}/agents`, request, AgentView);

/** `PATCH /agents/:id`: the agent as it now is. Nothing deletes an agent; disabling retires it. */
export const patchAgent = (
  agentId: string,
  patch: PatchAgentRequest,
): Promise<AgentView> =>
  patchJson(`/agents/${segment(agentId)}`, patch, AgentView);

/** The most open proposals the card counts; past it, it says `100+`. */
export const PROPOSALS_LIMIT = 100;

/** `GET /inbox?status=open&kind=staff_approval&project=`: one project's open staffing proposals. */
export const projectProposalsQuery = (project: string) =>
  queryOptions({
    queryKey: [...INBOX_KEY, "proposals", project],
    queryFn: ({ signal }) =>
      getJson(
        `/inbox?${new URLSearchParams({
          status: "open",
          kind: STAFF_APPROVAL_KIND,
          project,
          limit: String(PROPOSALS_LIMIT),
        }).toString()}`,
        InboxPage,
        signal,
      ),
  });

/** Every `inbox` frame refetches the project's proposal count: a request opened or was answered. */
export function useProposalsFeed(project: string): void {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      feed.subscribeInbox(() => {
        void queryClient.invalidateQueries({
          queryKey: projectProposalsQuery(project).queryKey,
        });
      }),
    [feed, queryClient, project],
  );
}

/** `projects` with `agent`'s enabled and max_concurrency as the server now has them. */
export const withAgent = (
  projects: ProjectsView,
  agent: AgentView,
): ProjectsView => ({
  projects: projects.projects.map((project) =>
    project.id !== agent.workspace_id
      ? project
      : {
          ...project,
          agents: project.agents.map((known) =>
            known.id === agent.id
              ? {
                  ...known,
                  enabled: agent.enabled,
                  max_concurrency: agent.max_concurrency,
                }
              : known,
          ),
        },
  ),
});

/**
 * After an agent write: show the server's answer at once, then refetch what it changes — the
 * projects (their agents), the pulse schedule (an enabled orchestrator pulses) and the agents'
 * session lists.
 */
export async function afterAgentWrite(
  queryClient: QueryClient,
  agent: AgentView,
): Promise<void> {
  queryClient.setQueryData<ProjectsView>(PROJECTS_KEY, (known) =>
    known === undefined ? undefined : withAgent(known, agent),
  );
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
    queryClient.invalidateQueries({ queryKey: pulseAgentsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: AGENT_SESSIONS_KEY }),
  ]);
}
