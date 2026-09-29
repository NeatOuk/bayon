import { NO_DELIVERY, NO_DOCS, NO_QA } from "@bayon/proto";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProjectsScreen } from "@/projects/projects-screen";
import { renderWithProviders, stubFetch } from "@/test/render";

const PROJECTS = "/api/v1/projects";

test("each project shows its repos, agents and a link to its open tickets", async () => {
  stubFetch({
    [PROJECTS]: {
      projects: [
        {
          id: "kite",
          name: "kite",
          kind: "submodule",
          repos: [
            {
              id: "kite",
              origin_url: "/src/kite",
              push_url: null,
              rel_path: "kite",
              submodule_path: null,
              default_base_branch: "main",
            },
            {
              id: "kite-kite-web",
              origin_url: "/src/kite/KITE-Web",
              push_url: null,
              rel_path: "kite/KITE-Web",
              submodule_path: "KITE-Web",
              default_base_branch: "master",
            },
          ],
          agents: [
            {
              id: "kite-builder",
              name: "kite-builder",
              kind: "builder",
              runner_id: "fixture",
              enabled: true,
              max_concurrency: 1,
            },
          ],
          open_tickets: 3,
          paused: false,
          staff_approval: false,
          jira: null,
          qa: NO_QA,
          docs: NO_DOCS,
          delivery: NO_DELIVERY,
        },
      ],
    },
  });
  renderWithProviders(<ProjectsScreen />);
  const panel = await screen.findByRole("region", { name: "project kite" });
  expect(within(panel).getByText("1 submodule")).toBeTruthy();
  const tickets = within(panel).getByRole("link", { name: "3 open tickets" });
  expect(tickets.getAttribute("href")).toBe("#/p/kite/tickets");
  const repos = within(panel).getByRole("list", { name: "repos" });
  expect(within(repos).getByText("KITE-Web")).toBeTruthy();
  expect(within(repos).getByText("master · /src/kite/KITE-Web")).toBeTruthy();
  const agents = within(panel).getByRole("list", { name: "agents" });
  expect(within(agents).getByText("builder · fixture")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "New project" }).getAttribute("href"),
  ).toBe("#/projects/new");
});

test("no projects yet says how to make one", async () => {
  stubFetch({ [PROJECTS]: { projects: [] } });
  renderWithProviders(<ProjectsScreen />);
  expect(await screen.findByText("No projects yet")).toBeTruthy();
});
