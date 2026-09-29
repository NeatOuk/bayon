import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  OPERATOR,
  newTicketInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { listProjects } from "./project-reads.js";
import { createTicket } from "./ticket-writes.js";
import { listTickets } from "./tickets.js";

// listProjects: each workspace with its repos, agents and open-ticket count; and
// listTickets by workspace, the board's project filter.
const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 1));
unwrap(
  await seedRows(t.db, {
    repos: [
      { id: "app", name: "app", mirror_path: "/m/app.git", has_submodules: 1 },
      { id: "app-web", name: "app-web", mirror_path: "/m/app-web.git" },
      { id: "tool", name: "tool", mirror_path: "/m/tool.git" },
    ],
    workspaces: [
      { id: "app", name: "app", kind: "submodule" },
      { id: "tool", name: "tool", kind: "single" },
      { id: "empty", name: "empty", kind: "single" },
    ],
    workspace_repos: [
      { workspace_id: "app", repo_id: "app", rel_path: "app", role: "primary" },
      {
        workspace_id: "app",
        repo_id: "app-web",
        rel_path: "app/web",
        role: "dep",
        submodule_path: "web",
      },
      { workspace_id: "tool", repo_id: "tool", rel_path: "tool" },
    ],
    agents: [
      {
        id: "app-builder",
        name: "app-builder",
        kind: "builder",
        runner_id: "fixture",
        workspace_id: "app",
        created_at: 1,
      },
      {
        id: "tool-builder",
        name: "tool-builder",
        kind: "builder",
        runner_id: "fixture",
        workspace_id: "tool",
        max_concurrency: 3,
        enabled: 0,
        created_at: 1,
      },
    ],
  }),
);
for (const [title, workspace_id, status] of [
  ["A open", "app", "backlog"],
  ["A building", "app", "building"],
  ["A done", "app", "done"],
  ["A rejected", "app", "rejected"],
  ["T open", "tool", "prioritized"],
  ["No project", null, "backlog"],
] as const) {
  unwrap(
    await createTicket(
      t.db,
      newTicketInput({ title, workspace_id, status }),
      OPERATOR,
    ),
  );
}

test("each workspace is a project with its repos, agents and open tickets", async () => {
  const projects = unwrap(await listProjects(t.db));
  const shape = projects.map((p) => ({
    id: p.workspace.id,
    kind: p.workspace.kind,
    repos: p.repos.map((r) => [r.id, r.rel_path, r.submodule_path]),
    agents: p.agents.map((a) => a.id),
    open: p.openTickets,
  }));
  expect(shape).toEqual([
    {
      id: "app",
      kind: "submodule",
      repos: [
        ["app", "app", null],
        ["app-web", "app/web", "web"],
      ],
      agents: ["app-builder"],
      open: 2, // done and rejected are not open
    },
    { id: "empty", kind: "single", repos: [], agents: [], open: 0 },
    {
      id: "tool",
      kind: "single",
      repos: [["tool", "tool", null]],
      agents: ["tool-builder"],
      open: 1,
    },
  ]);
});

test("an agent carries what the IDE's Agents view shows and edits", async () => {
  const projects = unwrap(await listProjects(t.db));
  const tool = projects.find((p) => p.workspace.id === "tool");
  expect(tool?.agents).toEqual([
    {
      id: "tool-builder",
      name: "tool-builder",
      kind: "builder",
      runner_id: "fixture",
      enabled: 0,
      max_concurrency: 3,
      workspace_id: "tool",
    },
  ]);
});

test("listTickets by workspace is one project's tickets", async () => {
  const titles = async (workspace_id?: string) =>
    unwrap(await listTickets(t.db, { workspace_id, limit: 50 })).rows.map(
      (r) => r.title,
    );
  expect(await titles("app")).toEqual([
    "A open",
    "A building",
    "A done",
    "A rejected",
  ]);
  expect(await titles("tool")).toEqual(["T open"]);
  expect(await titles()).toContain("No project");
});
