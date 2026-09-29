import { expect, test } from "vitest";
import {
  EXECUTORS_HREF,
  INBOX_HREF,
  NEW_PROJECT_HREF,
  PROJECTS_HREF,
  PULSES_HREF,
  REVIEWS_HREF,
  ROLES_HREF,
  RUNNERS_HREF,
  SPEND_HREF,
  TICKETS_HREF,
  inboxHref,
  missionHref,
  parseRoute,
  projectHref,
  pulseHref,
  resolveAlias,
  sessionHref,
  ticketHref,
  ticketsHref,
} from "@/routing";

/** A hash no screen answers to: Not found, naming the hash, never the Fleet. */
const NOT_FOUND = "not found";

test.each<[string, object | string]>([
  ["", { name: "fleet" }],
  ["#/", { name: "fleet" }],
  ["#/sessions/01J9", { name: "session", sessionId: "01J9" }],
  ["#/sessions/", NOT_FOUND],
  ["#/somewhere", NOT_FOUND],
  ["#/missions/builder-1", { name: "mission", agent: "builder-1" }],
  [
    "#/missions/builder-1?section=laws",
    { name: "mission", agent: "builder-1", section: "laws" },
  ],
  ["#/missions/builder-1?section=bogus", NOT_FOUND],
  ["#/missions/", NOT_FOUND],
  ["#/missions/%E0%A4%A", NOT_FOUND],
  ["#/tickets", { name: "tickets" }],
  ["#/tickets/812", { name: "ticket", num: 812 }],
  ["#/tickets/0", NOT_FOUND],
  ["#/tickets/08", NOT_FOUND],
  ["#/tickets/abc", NOT_FOUND],
  ["#/inbox", { name: "inbox" }],
  ["#/pulses", { name: "pulses" }],
  ["#/pulses/P-1", { name: "pulse", pulseId: "P-1" }],
  ["#/pulses/", NOT_FOUND],
  ["#/pulses/%E0%A4%A", NOT_FOUND],
  ["#/spend", { name: "spend" }],
  ["#/reviews", { name: "reviews" }],
  ["#/review/g1", NOT_FOUND],
  ["#/runners", { name: "runners" }],
  ["#/runners/r1", NOT_FOUND],
  ["#/executors", { name: "executors" }],
  ["#/executors/ctr-lab", NOT_FOUND],
  ["#/settings", { name: "general" }],
  ["#/settings/general", { name: "general" }],
  ["#/settings/roles", { name: "roles" }],
  ["#/settings/other", NOT_FOUND],
  ["#/audit", { name: "audit" }],
  ["#/audit/1", NOT_FOUND],
  ["#/p/ws-bayon", { name: "project", project: "ws-bayon", view: "overview" }],
  [
    "#/p/ws-bayon/tickets",
    { name: "project", project: "ws-bayon", view: "tickets" },
  ],
  [
    "#/p/ws-bayon/history?open=ticket:812",
    {
      name: "project",
      project: "ws-bayon",
      view: "history",
      open: { kind: "ticket", num: 812 },
    },
  ],
  [
    "#/p/ws-bayon/overview?open=session:01J9",
    {
      name: "project",
      project: "ws-bayon",
      view: "overview",
      open: { kind: "session", id: "01J9" },
    },
  ],
  ["#/p/", NOT_FOUND],
  ["#/p/ws-bayon/", NOT_FOUND],
  ["#/p/ws-bayon/bogus", NOT_FOUND],
  ["#/p/ws-bayon/overview?open=ticket:0", NOT_FOUND],
  [
    "#/p/ws-bayon/orchestrator?open=pulse:P1",
    {
      name: "project",
      project: "ws-bayon",
      view: "orchestrator",
      open: { kind: "pulse", id: "P1" },
    },
  ],
  ["#/p/ws-bayon/overview?open=gate:G1", NOT_FOUND],
  ["#/p/ws-bayon/overview?open=pulse:%E0%A4%A", NOT_FOUND],
  ["#/p/ws-bayon/overview?open=agent:%E0%A4%A", NOT_FOUND],
  ["#/p/%E0%A4%A/overview", NOT_FOUND],
  [
    "#/p/ws-bayon/history?q=x%20y&open=pulse:P1&kind=gate,ticket",
    {
      name: "project",
      project: "ws-bayon",
      view: "history",
      open: { kind: "pulse", id: "P1" },
      filters: { sources: ["ticket", "gate"], q: "x y" },
    },
  ],
  ["#/p/ws-bayon/history?", NOT_FOUND],
  ["#/p/ws-bayon/history?open", NOT_FOUND],
  ["#/p/ws-bayon/history?open=", NOT_FOUND],
  ["#/p/ws-bayon/history?q=a&q=b", NOT_FOUND],
  ["#/p/ws-bayon/history?open=ticket:1&open=ticket:2", NOT_FOUND],
  ["#/p/ws-bayon/history?q=", NOT_FOUND],
  ["#/p/ws-bayon/history?q=%E0%A4%A", NOT_FOUND],
  ["#/p/ws-bayon/history?sort=asc", NOT_FOUND],
  ["#/p/ws-bayon/history?kind=tickets", NOT_FOUND],
  ["#/p/ws-bayon/history?from=2026-13-01", NOT_FOUND],
  ["#/p/ws-bayon/overview?q=x", NOT_FOUND],
  ["#/p/ws-bayon/overview?open=ticket:1&kind=gate", NOT_FOUND],
])("parseRoute(%j)", (hash, route) => {
  expect(parseRoute(hash)).toEqual(
    route === NOT_FOUND ? { name: "notFound", hash } : route,
  );
});

test("the M2 hrefs round-trip through parseRoute", () => {
  expect(parseRoute(INBOX_HREF)).toEqual({ name: "inbox" });
  expect(parseRoute(PULSES_HREF)).toEqual({ name: "pulses" });
  expect(parseRoute(SPEND_HREF)).toEqual({ name: "spend" });
  expect(parseRoute(REVIEWS_HREF)).toEqual({ name: "reviews" });
  expect(parseRoute(RUNNERS_HREF)).toEqual({ name: "runners" });
  expect(parseRoute(EXECUTORS_HREF)).toEqual({ name: "executors" });
  expect(parseRoute(ROLES_HREF)).toEqual({ name: "roles" });
  expect(parseRoute(pulseHref("P 1"))).toEqual({
    name: "pulse",
    pulseId: "P 1",
  });
});

test("sessionHref round-trips through parseRoute", () => {
  expect(parseRoute(sessionHref("01J9"))).toEqual({
    name: "session",
    sessionId: "01J9",
  });
});

test("the projects and one project's board round-trip through parseRoute", () => {
  expect(parseRoute(PROJECTS_HREF)).toEqual({ name: "projects" });
  expect(parseRoute(NEW_PROJECT_HREF)).toEqual({ name: "newProject" });
  // One project's board is its IDE's Tickets view: the one address for it.
  expect(ticketsHref("ws a/b")).toBe("#/p/ws%20a%2Fb/tickets");
  expect(parseRoute(ticketsHref("ws a/b"))).toEqual({
    name: "project",
    project: "ws a/b",
    view: "tickets",
  });
  expect(ticketsHref(null)).toBe(TICKETS_HREF);
  expect(parseRoute("#/tickets?project=")).toEqual({
    name: "notFound",
    hash: "#/tickets?project=",
  });
});

test("the ticket hrefs round-trip through parseRoute", () => {
  expect(parseRoute(TICKETS_HREF)).toEqual({ name: "tickets" });
  expect(parseRoute(ticketHref(812))).toEqual({ name: "ticket", num: 812 });
});

test("missionHref round-trips through parseRoute, with and without a section", () => {
  expect(parseRoute(missionHref("qa one"))).toEqual({
    name: "mission",
    agent: "qa one",
  });
  expect(parseRoute(missionHref("qa one", "laws"))).toEqual({
    name: "mission",
    agent: "qa one",
    section: "laws",
  });
});

test("a project's views and tabs round-trip through parseRoute, ids encoded", () => {
  expect(projectHref("ws a/b")).toBe("#/p/ws%20a%2Fb/overview");
  for (const view of [
    "overview",
    "orchestrator",
    "agents",
    "tickets",
    "history",
  ] as const)
    expect(parseRoute(projectHref("ws a/b", view))).toEqual({
      name: "project",
      project: "ws a/b",
      view,
    });
  for (const open of [
    { kind: "ticket", num: 812 },
    { kind: "session", id: "01J9:x/y" },
    { kind: "agent", id: "ws-bayon builder?" },
    { kind: "pulse", id: "01JP:x/y" },
  ] as const)
    expect(parseRoute(projectHref("ws-bayon", "agents", open))).toEqual({
      name: "project",
      project: "ws-bayon",
      view: "agents",
      open,
    });
});

test("the history view's filters round-trip through parseRoute, beside a tab or not; other views drop them", () => {
  const filters = {
    sources: ["audit", "human_request"],
    agent: "ws a/b builder",
    ticket: "FRM-12",
    from: "2026-09-01",
    to: "2026-09-22",
    q: "50% & =?#",
  } as const;
  const href = projectHref("ws a/b", "history", undefined, filters);
  expect(href).toBe(
    "#/p/ws%20a%2Fb/history?kind=audit,human_request&agent=ws%20a%2Fb%20builder" +
      "&ticket=FRM-12&from=2026-09-01&to=2026-09-22&q=50%25%20%26%20%3D%3F%23",
  );
  expect(parseRoute(href)).toEqual({
    name: "project",
    project: "ws a/b",
    view: "history",
    filters,
  });
  const open = { kind: "session", id: "01J9:x/y" } as const;
  expect(parseRoute(projectHref("ws a/b", "history", open, filters))).toEqual({
    name: "project",
    project: "ws a/b",
    view: "history",
    open,
    filters,
  });
  // `?open=` alone is as it was; no filter set, or another view, writes none.
  expect(projectHref("ws-bayon", "history", { kind: "ticket", num: 8 })).toBe(
    "#/p/ws-bayon/history?open=ticket:8",
  );
  expect(projectHref("ws-bayon", "history", undefined, { sources: [] })).toBe(
    "#/p/ws-bayon/history",
  );
  expect(projectHref("ws-bayon", "agents", undefined, filters)).toBe(
    "#/p/ws-bayon/agents",
  );
});

// a ticket's "needs human" goes to the Inbox showing that ticket's requests.
test("the Inbox takes one ticket, fleet and project; inboxHref round-trips; a bad one is Not found", () => {
  expect(parseRoute("#/inbox?ticket=82")).toEqual({
    name: "inbox",
    ticket: 82,
  });
  expect(parseRoute(inboxHref(null, 82))).toEqual({
    name: "inbox",
    ticket: 82,
  });
  expect(inboxHref("kite", 82)).toBe("#/p/kite/inbox?ticket=82");
  expect(parseRoute(inboxHref("ws bayon", 82))).toEqual({
    name: "project",
    project: "ws bayon",
    view: "inbox",
    ticket: 82,
  });
  expect(parseRoute("#/p/kite/inbox?ticket=82&open=ticket:82")).toEqual({
    name: "project",
    project: "kite",
    view: "inbox",
    open: { kind: "ticket", num: 82 },
    ticket: 82,
  });
  for (const bad of [
    "#/inbox?ticket=0",
    "#/inbox?ticket=abc",
    "#/inbox?kind=x",
    "#/p/kite/inbox?ticket=0",
    "#/p/kite/inbox?ticket=1&kind=gate",
    "#/p/kite/overview?ticket=82",
  ]) {
    expect(parseRoute(bad), bad).toEqual({ name: "notFound", hash: bad });
  }
});

// one address per screen. A fleet screen narrowed to a project is that project's view;
// the old review queue address is the new one. Each alias parses as the screen it names.
test.each([
  ["#/tickets?project=ws-a", "#/p/ws-a/tickets"],
  ["#/tickets?project=ws%20a%2Fb", "#/p/ws%20a%2Fb/tickets"],
  ["#/inbox?project=kite", "#/p/kite/inbox"],
  ["#/inbox?project=kite&ticket=82", "#/p/kite/inbox?ticket=82"],
  ["#/inbox?ticket=82&project=kite", "#/p/kite/inbox?ticket=82"],
  ["#/spend?project=kite", "#/p/kite/spend"],
  ["#/reviews?project=kite", "#/p/kite/reviews"],
  ["#/review?project=kite", "#/p/kite/reviews"],
  ["#/review", "#/reviews"],
])("resolveAlias(%j) is %j, and parses as it", (alias, canonical) => {
  expect(resolveAlias(alias)).toBe(canonical);
  expect(parseRoute(alias)).toEqual(parseRoute(canonical));
});

test.each([
  "#/",
  "#/tickets",
  "#/reviews",
  "#/p/kite/tickets",
  "#/inbox?ticket=82",
  "#/tickets?project=",
  "#/tickets?project=a&project=b",
  "#/tickets?project=a&q=x",
  "#/spend?project=a&ticket=1",
  "#/inbox?project=a&ticket=0",
  "#/tickets?project=%E0%A4%A",
])("%j is no alias", (hash) => {
  expect(resolveAlias(hash)).toBeNull();
});

// a screen with tabs of its own keeps the open one in `?tab=`. The router takes it off
// before matching and carries it on the route; on any other screen it is an unknown pair.
test.each<[string, object | string]>([
  ["#/sessions/s1?tab=diff", { name: "session", sessionId: "s1", tab: "diff" }],
  ["#/inbox?tab=answered", { name: "inbox", tab: "answered" }],
  [
    "#/inbox?ticket=82&tab=dismissed",
    { name: "inbox", ticket: 82, tab: "dismissed" },
  ],
  [
    "#/inbox?tab=dismissed&ticket=82",
    { name: "inbox", ticket: 82, tab: "dismissed" },
  ],
  [
    "#/p/shop/inbox?tab=answered",
    { name: "project", project: "shop", view: "inbox", tab: "answered" },
  ],
  [
    "#/p/shop/inbox?ticket=82&tab=answered",
    {
      name: "project",
      project: "shop",
      view: "inbox",
      ticket: 82,
      tab: "answered",
    },
  ],
  [
    "#/p/shop/overview?open=session:s1&tab=watch",
    {
      name: "project",
      project: "shop",
      view: "overview",
      open: { kind: "session", id: "s1" },
      tab: "watch",
    },
  ],
  ["#/tickets/7?tab=diff", NOT_FOUND],
  ["#/?tab=diff", NOT_FOUND],
  ["#/pulses/p1?tab=checks", NOT_FOUND],
  ["#/sessions/s1?tab=", NOT_FOUND],
  ["#/sessions/s1?tab=a&tab=b", NOT_FOUND],
])("parseRoute(%j) with a tab is %j", (hash, expected) => {
  expect(parseRoute(hash)).toEqual(
    expected === NOT_FOUND ? { name: "notFound", hash } : expected,
  );
});
