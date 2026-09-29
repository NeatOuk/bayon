import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "@/app";
import {
  fleet,
  missionVersion,
  missionView,
  sessionView,
} from "@/test/fixtures";
import { sessionDiff } from "@/test/diff-fixtures";
import { gatesPage } from "@/test/gate-fixtures";
import { inboxPage } from "@/test/inbox-fixtures";
import { pulseDetail, pulseView } from "@/test/pulse-fixtures";
import { silentFeed, stubFetch } from "@/test/render";
import { spendSummary } from "@/test/spend-fixtures";
import {
  ticketDetail,
  ticketSummary,
  ticketView,
  ticketsPage,
} from "@/test/ticket-fixtures";

const renderApp = () =>
  render(
    <App
      feed={silentFeed}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );

const navigate = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

afterEach(() => {
  window.location.hash = "";
  document.documentElement.classList.remove("dark");
  localStorage.clear();
});

test("the hash picks the screen: fleet by default, a session's timeline by id", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/sessions/s1": sessionView({ id: "s1", state: "idle" }),
  });
  renderApp();
  expect(await screen.findByText(/no live sessions/i)).toBeTruthy();
  navigate("#/sessions/s1");
  expect(await screen.findByRole("tab", { name: "Timeline" })).toBeTruthy();
  navigate("#/");
  expect(await screen.findByText(/no live sessions/i)).toBeTruthy();
});

test("the Tickets link opens the board, and a ticket number its detail", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/tickets?limit=100": ticketsPage([ticketSummary({ num: 812 })]),
    "/api/v1/tickets/812": ticketDetail(
      ticketView({ num: 812, title: "transfer" }),
    ),
  });
  renderApp();
  const link = screen.getByRole("link", { name: "Tickets" });
  expect(link.getAttribute("href")).toBe("#/tickets");
  navigate("#/tickets");
  expect(await screen.findByRole("region", { name: "Backlog" })).toBeTruthy();
  navigate("#/tickets/812");
  expect(
    await screen.findByRole("heading", { name: "FRM-812 · transfer" }),
  ).toBeTruthy();
});

test("add a law, from a session's timeline, opens its agent's mission with the laws focused", async () => {
  stubFetch({
    "/api/v1/sessions/s1": sessionView({ id: "s1", agent_name: "qa one" }),
    "/api/v1/missions/qa%20one": missionView(
      [missionVersion({ version: 1, agent_name: "qa one" })],
      "qa one",
    ),
  });
  navigate("#/sessions/s1");
  renderApp();
  const link = await screen.findByRole("link", { name: "add a law" });
  expect(link.getAttribute("href")).toBe("#/missions/qa%20one?section=laws");
  navigate(link.getAttribute("href") ?? "");
  const laws = await screen.findByLabelText("Laws");
  await waitFor(() => expect(document.activeElement).toBe(laws));
});

test("the user menu's theme switches the dark palette on the root element and remembers it", async () => {
  stubFetch({ "/api/v1/fleet": fleet([]) });
  const user = userEvent.setup();
  renderApp();
  const root = document.documentElement.classList;
  for (const [choice, dark] of [
    ["Dark", true],
    ["Light", false],
  ] as const) {
    await user.click(screen.getByRole("button", { name: "User menu" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: choice }),
    );
    expect(root.contains("dark")).toBe(dark);
    expect(localStorage.getItem("bayon.theme")).toBe(choice.toLowerCase());
  }
});

test("terminal shows a not-attached state for a running session; diff reads the session's diff", async () => {
  stubFetch({
    "/api/v1/sessions/s1": sessionView({
      id: "s1",
      state: "running",
      turns: 3,
      cost_usd: 0.25,
    }),
    "/api/v1/sessions/s1/diff": sessionDiff({
      session_id: "s1",
      source: "none",
      repos: [],
      reason: "session s1 holds no worktree",
    }),
  });
  const user = userEvent.setup();
  navigate("#/sessions/s1");
  renderApp();
  expect((await screen.findByText("Running")).dataset.tone).toBe("info");
  await user.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(screen.getByRole("tabpanel").textContent).toMatch(/Not attached/);
  await user.click(screen.getByRole("tab", { name: "Diff" }));
  expect(
    await within(screen.getByRole("tabpanel")).findByText(
      "session s1 holds no worktree",
    ),
  ).toBeTruthy();
});

test("the sidebar reaches the reviews, the inbox, the pulses (and one pulse) and spend", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/gates?state=running%2Cfailed&latest=1&limit=100": gatesPage([]),
    "/api/v1/inbox?status=open": inboxPage([]),
    "/api/v1/pulses": { items: [] },
    "/api/v1/pulses/P-1": pulseDetail(pulseView({ id: "P-1" })),
    "/api/v1/agents/pulse-policies": { items: [] },
    "/api/v1/spend?group=day": {
      group: "day",
      summary: spendSummary(),
      rows: [],
    },
  });
  renderApp();
  for (const [name, href] of [
    ["Reviews", "#/reviews"],
    ["Inbox", "#/inbox"],
    ["Pulses", "#/pulses"],
    ["Spend", "#/spend"],
  ])
    expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(href);
  navigate("#/reviews");
  expect(await screen.findByRole("heading", { name: "Reviews" })).toBeTruthy();
  navigate("#/inbox");
  expect(await screen.findByRole("heading", { name: "Inbox" })).toBeTruthy();
  navigate("#/pulses");
  expect(await screen.findByRole("heading", { name: "Pulses" })).toBeTruthy();
  navigate("#/pulses/P-1");
  expect(await screen.findByRole("heading", { name: "Pulse" })).toBeTruthy();
  navigate("#/spend");
  expect(await screen.findByRole("heading", { name: "Spend" })).toBeTruthy();
});

test("the sidebar reaches the runners, the executors and Settings → Roles", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/runners": { runners: [] },
    "/api/v1/executors": { executors: [], untrusted_roles: ["investigator"] },
    "/api/v1/role-bindings": { items: [] },
  });
  renderApp();
  for (const [name, href] of [
    ["Runners", "#/runners"],
    ["Executors", "#/executors"],
    ["Settings", "#/settings"],
    ["Audit", "#/audit"],
  ])
    expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(href);
  navigate("#/runners");
  expect(await screen.findByRole("heading", { name: "Runners" })).toBeTruthy();
  expect(await screen.findByText("No runner registered")).toBeTruthy();
  navigate("#/executors");
  expect(
    await screen.findByRole("heading", { name: "Executors" }),
  ).toBeTruthy();
  expect(await screen.findByText("No executor registered")).toBeTruthy();
  navigate("#/settings/roles");
  expect(
    await screen.findByRole("heading", { name: "Settings · Roles" }),
  ).toBeTruthy();
  expect(
    await screen.findByRole("table", { name: "role bindings" }),
  ).toBeTruthy();
});

// the slim top bar. One row: Search, the fleet pause stating the fleet's state in words,
// and the user menu, which holds Log out behind the production edge.
test("the top bar states the fleet's state in words and keeps Log out in the user menu", async () => {
  stubFetch({ "/api/v1/fleet": fleet([], { paused: true }) });
  const logout = vi.fn();
  render(
    <App
      feed={silentFeed}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
      onLogout={logout}
    />,
  );
  const bar = screen.getByRole("banner");
  expect(within(bar).getByRole("switch", { name: "Pause fleet" })).toBeTruthy();
  await waitFor(() =>
    expect(within(bar).getByRole("status").textContent).toBe("Fleet paused"),
  );
  expect(
    within(bar).getByRole("button", { name: "Search everywhere" }),
  ).toBeTruthy();
  expect(within(bar).queryByRole("link", { name: "Tickets" })).toBeNull();
  const user = userEvent.setup();
  await user.click(within(bar).getByRole("button", { name: "User menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Log out" }));
  expect(logout).toHaveBeenCalledOnce();
});
