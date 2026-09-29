import type { ProjectView } from "@bayon/proto";
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import { App } from "@/app";
import type { Feed } from "@/feed/feed";
import { fleet, missionView } from "@/test/fixtures";
import { inboxPage } from "@/test/inbox-fixtures";
import {
  agentSessionsPage,
  projectsView,
  timelinePage,
} from "@/test/project-fixtures";
import { silentFeed, stubFetch } from "@/test/render";
import { ticketsPage } from "@/test/ticket-fixtures";

// The project IDE inside the whole app, so its links navigate: the routes every
// render reads — the header's fleet, the projects, the activity panel, the unfiltered history
//, the pulse schedule, the open proposals, and an orchestrator's pulses and mission
// — answered empty unless a test says otherwise.

/** `GET /inbox`'s query for one project's open staffing proposals. */
export const proposalsUrl = (project: string): string =>
  `/api/v1/inbox?status=open&kind=staff_approval&project=${project}&limit=100`;

/** `GET /pulses?agent=`: one agent's newest pulses (the Orchestrator view's list). */
export const agentPulsesUrl = (agent: string): string =>
  `/api/v1/pulses?agent=${agent}&limit=10`;

/** `GET /missions/:agent`, by the agent's name. */
export const missionUrl = (agent: string): string =>
  `/api/v1/missions/${agent}`;

/** `GET /projects/:id/timeline` as the History view asks it: 50 rows, then `query`. */
export const historyUrl = (project: string, query = ""): string =>
  `/api/v1/projects/${project}/timeline?limit=50${query === "" ? "" : `&${query}`}`;

/** `GET /agents/:id/sessions`'s first page, and the one after `cursor`. */
export const sessionsUrl = (agent: string, cursor?: string): string =>
  `/api/v1/agents/${agent}/sessions?limit=25${cursor === undefined ? "" : `&cursor=${cursor}`}`;

/** The project's board, as the Tickets view and the Overview's "Waiting on you" fetch it. */
export const projectTicketsUrl = (project: string): string =>
  `/api/v1/tickets?workspace_id=${encodeURIComponent(project)}&limit=100`;

export const ideRoutes = (
  project: ProjectView,
): Readonly<Record<string, unknown>> => ({
  "/api/v1/fleet": fleet([]),
  "/api/v1/projects": projectsView(project),
  [`/api/v1/projects/${project.id}/timeline?limit=30`]: timelinePage([]),
  [historyUrl(project.id)]: timelinePage([]),
  "/api/v1/agents/pulse-policies": { items: [] },
  // The Tickets view's Jira strip: the project's own source, never synced; a token found.
  [`/api/v1/projects/${project.id}/jira`]: {
    source: project.jira,
    last_sync: null,
  },
  "/api/v1/jira": {
    secret: "JIRA_API_TOKEN",
    store: "keychain",
    keychain: { service: "foreman", owner: true },
    present: true,
  },
  [proposalsUrl(project.id)]: inboxPage([]),
  // Settings → Models resolves each step's model from the runners and the role bindings.
  "/api/v1/runners": { runners: [] },
  "/api/v1/role-bindings": { items: [] },
  // The Overview's "Waiting on you" and the Tickets view read the project's board.
  [projectTicketsUrl(project.id)]: ticketsPage([]),
  ...Object.fromEntries(
    project.agents.map((agent) => [
      sessionsUrl(agent.id),
      agentSessionsPage([]),
    ]),
  ),
  ...Object.fromEntries(
    project.agents
      .filter((agent) => agent.kind === "orchestrator")
      .flatMap((agent) => [
        [agentPulsesUrl(agent.id), { items: [] }],
        [missionUrl(agent.name), missionView([], agent.name)],
      ]),
  ),
});

/**
 * Renders the app at `hash` over `project`'s routes plus `routes`; returns the fetch stub. A test
 * that must tell an invalidation from a remount's refetch passes its own `queryClient`.
 */
export function renderIde(
  hash: string,
  project: ProjectView,
  routes: Readonly<Record<string, unknown>> = {},
  feed: Feed = silentFeed,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  const fetchMock = stubFetch({ ...ideRoutes(project), ...routes });
  window.location.hash = hash;
  render(<App feed={feed} queryClient={queryClient} />);
  return fetchMock;
}

/** Moves the app to `hash`, as a click on a link would. */
export const navigate = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

/** The editor strip's tab names. */
export const tabNames = () =>
  within(screen.getByRole("tablist", { name: "open editors" }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
