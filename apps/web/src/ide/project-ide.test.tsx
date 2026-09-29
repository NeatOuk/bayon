import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { App } from "@/app";
import { fleet, sessionView } from "@/test/fixtures";
import { historyUrl, proposalsUrl, sessionsUrl } from "@/test/ide-harness";
import { inboxPage } from "@/test/inbox-fixtures";
import {
  agentSessionsPage,
  projectView,
  projectsView,
  timelinePage,
} from "@/test/project-fixtures";
import { callsTo, silentFeed, stubFetch } from "@/test/render";
import {
  ticketDetail,
  ticketSummary,
  ticketView,
  ticketsPage,
} from "@/test/ticket-fixtures";

const BAYON = projectView();
const KITE = projectView({ id: "kite", name: "kite", paused: true });

/**
 * Every screen's header reads these; the IDE reads the projects and its activity, the Overview the
 * pulse schedule and the open proposals, an agent tab its sessions.
 */
const BASE = {
  "/api/v1/fleet": fleet([]),
  "/api/v1/projects": projectsView(BAYON, KITE),
  "/api/v1/projects/ws-bayon/timeline?limit=30": timelinePage([]),
  "/api/v1/projects/kite/timeline?limit=30": timelinePage([]),
  [historyUrl("ws-bayon")]: timelinePage([]),
  "/api/v1/agents/pulse-policies": { items: [] },
  [proposalsUrl("ws-bayon")]: inboxPage([]),
  [proposalsUrl("kite")]: inboxPage([]),
  [sessionsUrl("bayon-builder")]: agentSessionsPage([]),
};

const renderAt = (hash: string, routes: Record<string, unknown> = {}) => {
  const fetchMock = stubFetch({ ...BASE, ...routes });
  window.location.hash = hash;
  render(
    <App
      feed={silentFeed}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  return fetchMock;
};

const navigate = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

const explorer = () => screen.getByRole("navigation", { name: "explorer" });
const editors = () => screen.getByRole("tablist", { name: "open editors" });
const tabNames = () =>
  within(editors())
    .getAllByRole("tab")
    .map((tab) => tab.textContent);

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

test("the switcher lists the projects and All projects; a project opens its overview, All projects the Fleet", async () => {
  renderAt("#/");
  const user = userEvent.setup();
  expect(await screen.findByText(/no live sessions/i)).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: "Switch project" }));
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "All projects",
    "bayon",
    "kite",
  ]);
  await user.click(screen.getByRole("option", { name: "bayon" }));
  expect(window.location.hash).toBe("#/p/ws-bayon/overview");
  expect(await screen.findByRole("heading", { name: "bayon" })).toBeTruthy();

  await user.click(screen.getByRole("combobox", { name: "Switch project" }));
  await user.click(await screen.findByRole("option", { name: "All projects" }));
  expect(window.location.hash).toBe("#/");
  expect(await screen.findByText(/no live sessions/i)).toBeTruthy();
});

// one sidebar. Inside a project it is the project's explorer, headed by the way back to
// all projects and the project's paused state; the fleet's screens are one click away, not beside.
test("inside a project the sidebar is its explorer, with the way back and the project's paused state", async () => {
  renderAt("#/p/kite/overview");
  expect(await screen.findByText("Project paused")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "All projects" }).getAttribute("href"),
  ).toBe("#/");
  expect(screen.queryByRole("navigation", { name: "main" })).toBeNull();
  expect(within(explorer()).queryByRole("link", { name: "Pulses" })).toBeNull();
  navigate("#/p/ws-bayon/overview");
  expect(await screen.findByText("Project running")).toBeTruthy();
  navigate("#/");
  expect(await screen.findByRole("navigation", { name: "main" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "explorer" })).toBeNull();
});

test("Overview shows the project's own kind, repos, agents and open tickets", async () => {
  renderAt("#/p/ws-bayon", {
    "/api/v1/projects": projectsView(
      projectView({
        kind: "submodule",
        staff_approval: true,
        repos: [
          ...BAYON.repos,
          {
            id: "bayon-web",
            origin_url: "/src/bayon/web",
            push_url: null,
            rel_path: "bayon/web",
            submodule_path: "web",
            default_base_branch: "develop",
          },
        ],
      }),
    ),
  });
  expect(await screen.findByRole("heading", { name: "bayon" })).toBeTruthy();
  expect(screen.getByText("repo with submodules")).toBeTruthy();
  expect(screen.getByText("staffing waits for approval")).toBeTruthy();
  const open = screen.getByRole("link", { name: "3" });
  expect(open.getAttribute("href")).toBe("#/p/ws-bayon/tickets");
  expect(screen.getByText("1 enabled")).toBeTruthy();
  const repos = screen.getByRole("region", { name: "repos" });
  expect(within(repos).getByText("2 repos")).toBeTruthy();
  expect(within(repos).getByText("develop · /src/bayon/web")).toBeTruthy();
  expect(tabNames()).toEqual(["Overview"]);
});

test("the explorer marks the current view, navigates, and lists the agents; an agent opens as a tab", async () => {
  renderAt("#/p/ws-bayon/overview");
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "bayon" });
  const current = within(explorer()).getByRole("link", { current: "page" });
  expect(current.textContent).toBe("Overview");

  await user.click(within(explorer()).getByRole("link", { name: "History" }));
  expect(
    await screen.findByText("This project has no history yet."),
  ).toBeTruthy();
  expect(window.location.hash).toBe("#/p/ws-bayon/history");
  expect(
    within(explorer()).getByRole("link", { current: "page" }).textContent,
  ).toBe("History");

  const agents = within(explorer()).getByRole("list", { name: "agents" });
  expect(
    within(agents).getByText("builder · fixture · model-mid"),
  ).toBeTruthy();
  expect(
    within(agents).getByText("reviewer · fixture · disabled"),
  ).toBeTruthy();
  await user.click(within(agents).getByRole("link", { name: /bayon-builder/ }));
  expect(
    await screen.findByRole("heading", { name: "bayon-builder" }),
  ).toBeTruthy();
  expect(window.location.hash).toBe(
    "#/p/ws-bayon/history?open=agent:bayon-builder",
  );
  expect(tabNames()).toEqual(["History", "bayon-builder"]);
  expect(
    screen.getByRole("link", { name: "Mission" }).getAttribute("href"),
  ).toBe("#/missions/bayon-builder");

  await user.click(
    within(explorer()).getByRole("button", { name: "the project's agents" }),
  );
  await waitFor(() =>
    expect(within(explorer()).queryByRole("list", { name: "agents" })).toBe(
      null,
    ),
  );
});

test("tabs open from links, focus by navigating, and close back to their left neighbour", async () => {
  renderAt("#/p/ws-bayon/overview?open=ticket:812", {
    "/api/v1/tickets/812": ticketDetail(
      ticketView({ num: 812, title: "transfer" }),
    ),
    "/api/v1/sessions/01JSESSIONABCDEF123456": sessionView({
      id: "01JSESSIONABCDEF123456",
      state: "idle",
    }),
  });
  const user = userEvent.setup();
  expect(
    await screen.findByRole("heading", { name: "FRM-812 · transfer" }),
  ).toBeTruthy();
  expect(screen.queryByRole("link", { name: "← Tickets" })).toBe(null);
  await waitFor(() => expect(tabNames()).toEqual(["Overview", "FRM-812"]));

  navigate("#/p/ws-bayon/overview?open=session:01JSESSIONABCDEF123456");
  expect(await screen.findByRole("tab", { name: "Timeline" })).toBeTruthy();
  expect(tabNames()).toEqual(["Overview", "FRM-812", "session …123456"]);
  expect(
    within(editors()).getByRole("tab", { selected: true }).textContent,
  ).toBe("session …123456");

  await user.click(within(editors()).getByRole("tab", { name: "FRM-812" }));
  expect(window.location.hash).toBe("#/p/ws-bayon/overview?open=ticket:812");
  await screen.findByRole("heading", { name: "FRM-812 · transfer" });

  await user.click(screen.getByRole("button", { name: "close FRM-812" }));
  expect(window.location.hash).toBe("#/p/ws-bayon/overview");
  expect(await screen.findByRole("heading", { name: "bayon" })).toBeTruthy();
  expect(tabNames()).toEqual(["Overview", "session …123456"]);

  await user.click(
    screen.getByRole("button", { name: "close session …123456" }),
  );
  expect(tabNames()).toEqual(["Overview"]);
  expect(window.location.hash).toBe("#/p/ws-bayon/overview");
});

test("closing a tab from the keyboard leaves focus on the tab that becomes active, not the page", async () => {
  renderAt("#/p/ws-bayon/overview?open=ticket:812", {
    "/api/v1/tickets/812": ticketDetail(
      ticketView({ num: 812, title: "transfer" }),
    ),
    "/api/v1/sessions/s1": sessionView({ id: "s1", state: "idle" }),
  });
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "FRM-812 · transfer" });
  navigate("#/p/ws-bayon/overview?open=session:s1");
  await screen.findByRole("tab", { name: "Timeline" });
  const selected = () => within(editors()).getByRole("tab", { selected: true });

  screen.getByRole("button", { name: "close session s1" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(selected().textContent).toBe("FRM-812"));
  expect(document.activeElement).toBe(selected());

  screen.getByRole("button", { name: "close FRM-812" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(selected().textContent).toBe("Overview"));
  expect(document.activeElement).toBe(selected());
});

test("the Tickets view is this project's board only, and a card opens as a tab", async () => {
  const fetchMock = renderAt("#/p/ws-bayon/tickets", {
    "/api/v1/tickets?workspace_id=ws-bayon&limit=100": ticketsPage([
      ticketSummary({ num: 5, workspace_id: "ws-bayon" }),
    ]),
    "/api/v1/tickets/5": ticketDetail(ticketView({ num: 5, title: "five" })),
  });
  const user = userEvent.setup();
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  expect(
    callsTo(fetchMock, "/api/v1/tickets?workspace_id=ws-bayon&limit=100"),
  ).toHaveLength(1);
  expect(callsTo(fetchMock, "/api/v1/tickets?limit=100")).toHaveLength(0);
  const card = within(backlog).getByRole("link", { name: /FRM-5/ });
  expect(card.getAttribute("href")).toBe("#/p/ws-bayon/tickets?open=ticket:5");
  await user.click(card);
  expect(
    await screen.findByRole("heading", { name: "FRM-5 · five" }),
  ).toBeTruthy();
  expect(tabNames()).toEqual(["Tickets", "FRM-5"]);
});

test("a project this install lacks says so and points to the Projects screen", async () => {
  renderAt("#/p/gone/overview");
  expect(await screen.findByText("No project gone")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Projects" }).getAttribute("href"),
  ).toBe("#/projects");
});
