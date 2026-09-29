import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";
import { navigate, renderIde } from "@/test/ide-harness";
import { projectView, projectsView } from "@/test/project-fixtures";

// One sidebar everywhere: the fleet's screens in groups and the projects; inside a
// project, its explorer. The current page is aria-current and looks it, apart from hover.

const BAYON = projectView();
const KITE = projectView({
  id: "kite",
  name: "kite",
  paused: true,
  open_tickets: 0,
  agents: [],
});
const ROUTES = {
  "/api/v1/projects": projectsView(BAYON, KITE),
  "/api/v1/inbox?status=open": inboxPage([
    inboxItem({ id: "q1" }),
    inboxItem({ id: "q2" }),
  ]),
};

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

const main = () => screen.getByRole("navigation", { name: "main" });
const listed = (group: string) =>
  within(within(main()).getByRole("list", { name: group }))
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label") ?? link.textContent);
const currentLinks = () => document.querySelectorAll('a[aria-current="page"]');

test("the fleet's screens in three groups, then the projects with New project", async () => {
  renderIde("#/", BAYON, ROUTES);
  await within(main()).findByRole("link", { name: /^bayon/ });
  expect(listed("Work")).toEqual(["Fleet", "Tickets", "Reviews", "Inbox2"]);
  expect(listed("Fleet")).toEqual(["Pulses", "Spend", "Runners", "Executors"]);
  expect(listed("Admin")).toEqual(["Settings", "Audit"]);
  expect(listed("Projects")).toEqual(["bayon3", "kite", "New project"]);
  const projects = within(main()).getByRole("list", { name: "Projects" });
  expect(
    within(projects)
      .getByRole("link", { name: /^bayon/ })
      .getAttribute("href"),
  ).toBe("#/p/ws-bayon/overview");
  expect(within(projects).getByLabelText("3 open tickets")).toBeTruthy();
  expect(within(projects).getByRole("img", { name: "paused" })).toBeTruthy();
  expect(
    within(projects)
      .getByRole("link", { name: "New project" })
      .getAttribute("href"),
  ).toBe("#/projects/new");
});

test("the Inbox carries its open count as a badge with words", async () => {
  renderIde("#/", BAYON, ROUTES);
  const badge = await within(main()).findByLabelText("2 open in the inbox");
  expect(badge.dataset.slot).toBe("badge");
  expect(badge.textContent).toBe("2");
});

test("the current page is aria-current, alone, and follows navigation; a section owns its sub-pages", async () => {
  renderIde("#/", BAYON, ROUTES);
  const fleet = within(main()).getByRole("link", { name: "Fleet" });
  expect(fleet.getAttribute("aria-current")).toBe("page");
  expect(currentLinks()).toHaveLength(1);
  for (const [hash, name] of [
    ["#/tickets/812", "Tickets"],
    ["#/pulses/P-1", "Pulses"],
    ["#/settings/roles", "Settings"],
    ["#/audit", "Audit"],
    ["#/projects/new", "New project"],
    ["#/projects", "Projects"],
  ] as const) {
    navigate(hash);
    const link = within(main()).getByRole("link", { name });
    expect(link.getAttribute("aria-current"), hash).toBe("page");
    expect(currentLinks(), hash).toHaveLength(1);
  }
  navigate("#/sessions/s1");
  expect(currentLinks()).toHaveLength(0);
});

test("the current row's look is the selected surface and an accent bar, never the hover fill", async () => {
  renderIde("#/spend", BAYON, ROUTES);
  const spend = within(main()).getByRole("link", { name: "Spend" });
  const audit = within(main()).getByRole("link", { name: "Audit" });
  expect(spend.className).toContain("bg-selected");
  expect(spend.className).toContain("before:bg-primary");
  expect(spend.className).not.toContain("hover:bg-accent");
  expect(audit.className).toContain("hover:bg-accent");
  expect(audit.className).not.toContain("bg-selected");
});

test("inside a project: the way back, its name and state, its explorer; an agent tab marks the agent", async () => {
  renderIde("#/p/ws-bayon/history", BAYON, ROUTES);
  const explorer = await screen.findByRole("navigation", { name: "explorer" });
  expect(
    screen.getByRole("link", { name: "All projects" }).getAttribute("href"),
  ).toBe("#/");
  expect(screen.getByText("Project running")).toBeTruthy();
  expect(
    within(explorer)
      .getByRole("link", { name: "History" })
      .getAttribute("aria-current"),
  ).toBe("page");

  const user = userEvent.setup();
  const agents = within(explorer).getByRole("list", { name: "agents" });
  await user.click(within(agents).getByRole("link", { name: /bayon-builder/ }));
  await waitFor(() =>
    expect(
      within(agents)
        .getByRole("link", { name: /bayon-builder/ })
        .getAttribute("aria-current"),
    ).toBe("page"),
  );
  expect(currentLinks()).toHaveLength(1);
});

test("a project the install lacks: the way back, and no explorer", async () => {
  renderIde("#/p/gone/overview", BAYON, ROUTES);
  expect(
    await screen.findByText("This install has no such project."),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "All projects" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "explorer" })).toBeNull();
  // The skip link is the first stop, and moves focus past the sidebar.
  const user = userEvent.setup();
  await user.tab();
  const skip = screen.getByRole("button", { name: "Skip to content" });
  expect(document.activeElement).toBe(skip);
  await act(async () => {
    skip.click();
  });
  expect(document.activeElement).toBe(screen.getByRole("main"));
});
