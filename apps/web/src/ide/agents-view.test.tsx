import type { AgentView, ProjectAgentView, ProjectView } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { renderIde } from "@/test/ide-harness";
import {
  projectAgent,
  projectView,
  projectsView,
} from "@/test/project-fixtures";
import { apiError, bodyOf, callsTo } from "@/test/render";
import { certification, runnerView, runnersView } from "@/test/runner-fixtures";

// The Agents view: enable, disable (asked first) and resize an agent through
// `PATCH /agents/:id`, and add one through `POST /projects/:id/agents`. Runner ids are data.

const BUILDER = projectAgent({ id: "bayon-builder", runner_id: "runner-a" });
const REVIEWER = projectAgent({
  id: "bayon-reviewer",
  kind: "reviewer",
  runner_id: "runner-b",
  enabled: false,
});

const agentView = (agent: ProjectAgentView): AgentView => ({
  ...agent,
  profile_id: `ws-bayon-${agent.kind}-${agent.runner_id}`,
  workspace_id: "ws-bayon",
  executor_id: "local",
});

/** A server over one project: `GET /projects` answers what the writes left. */
function server(initial: ProjectView) {
  let project = initial;
  const patchAgent =
    (id: string) =>
    (init: RequestInit | undefined): AgentView => {
      const patch = JSON.parse(String(init?.body)) as Partial<ProjectAgentView>;
      project = {
        ...project,
        agents: project.agents.map((a) =>
          a.id === id ? { ...a, ...patch } : a,
        ),
      };
      const agent = project.agents.find((a) => a.id === id);
      if (agent === undefined) throw new Error(`no agent ${id}`);
      return agentView(agent);
    };
  return {
    routes: {
      "/api/v1/projects": () => projectsView(project),
      "/api/v1/agents/bayon-builder": patchAgent("bayon-builder"),
      "/api/v1/agents/bayon-reviewer": patchAgent("bayon-reviewer"),
    },
    add: (agent: ProjectAgentView) => {
      project = { ...project, agents: [...project.agents, agent] };
      return agentView(agent);
    },
  };
}

const row = async (name: string) => {
  const list = await screen.findByRole("list", { name: "project agents" });
  const link = within(list).getByRole("link", { name });
  const item = link.closest("li");
  if (item === null) throw new Error(`no row for ${name}`);
  return item;
};

const enabledSwitch = (name: string) =>
  screen.getByRole("switch", { name: `${name} Enabled`, hidden: true });

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

test("each agent shows its kind, runner and live state; the copy says nothing deletes one", async () => {
  renderIde(
    "#/p/ws-bayon/agents",
    projectView({ agents: [BUILDER, REVIEWER] }),
  );
  const builder = await row("bayon-builder");
  expect(within(builder).getByText("Builder")).toBeTruthy();
  // The runner id in monospace, as data.
  expect(within(builder).getByText("runner-a").className).toContain(
    "font-mono",
  );
  expect(within(builder).getByText("Idle")).toBeTruthy();
  expect(
    within(await row("bayon-reviewer")).getByText("Disabled").dataset.tone,
  ).toBe("neutral");
  expect(
    screen.getByText(/^Nothing deletes an agent: disable one to retire it\./),
  ).toBeTruthy();
  expect(
    within(builder)
      .getByRole("link", { name: "bayon-builder" })
      .getAttribute("href"),
  ).toBe("#/p/ws-bayon/agents?open=agent:bayon-builder");
});

test("disabling asks first: cancel writes nothing, confirming PATCHes and the switch follows the server", async () => {
  const { routes } = server(projectView({ agents: [BUILDER, REVIEWER] }));
  const fetchMock = renderIde("#/p/ws-bayon/agents", projectView(), routes);
  const user = userEvent.setup();
  await row("bayon-builder");
  expect(enabledSwitch("bayon-builder").getAttribute("aria-checked")).toBe(
    "true",
  );

  await user.click(enabledSwitch("bayon-builder"));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Disable bayon-builder?")).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBe(null));
  expect(callsTo(fetchMock, "/api/v1/agents/bayon-builder", "PATCH")).toEqual(
    [],
  );
  expect(enabledSwitch("bayon-builder").getAttribute("aria-checked")).toBe(
    "true",
  );

  await user.click(enabledSwitch("bayon-builder"));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Disable bayon-builder",
    }),
  );
  await waitFor(() =>
    expect(enabledSwitch("bayon-builder").getAttribute("aria-checked")).toBe(
      "false",
    ),
  );
  expect(bodyOf(fetchMock, "/api/v1/agents/bayon-builder", "PATCH")).toEqual({
    enabled: false,
  });
  expect(within(await row("bayon-builder")).getByText("Disabled")).toBeTruthy();
  expect(callsTo(fetchMock, "/api/v1/projects").length).toBeGreaterThan(1);
});

test("a refused disable keeps the dialog open with the server's reason", async () => {
  renderIde("#/p/ws-bayon/agents", projectView({ agents: [BUILDER] }), {
    "/api/v1/agents/bayon-builder": apiError(
      404,
      "not_found",
      "agent bayon-builder does not exist",
    ),
  });
  const user = userEvent.setup();
  await row("bayon-builder");
  await user.click(enabledSwitch("bayon-builder"));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(
    within(dialog).getByRole("button", { name: "Disable bayon-builder" }),
  );
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Not disabled: not_found: agent bayon-builder does not exist",
  );
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  expect(enabledSwitch("bayon-builder").getAttribute("aria-checked")).toBe(
    "true",
  );
});

test("enabling writes at once, with no question", async () => {
  const { routes } = server(projectView({ agents: [BUILDER, REVIEWER] }));
  const fetchMock = renderIde("#/p/ws-bayon/agents", projectView(), routes);
  const user = userEvent.setup();
  await row("bayon-reviewer");
  await user.click(enabledSwitch("bayon-reviewer"));
  await waitFor(() =>
    expect(enabledSwitch("bayon-reviewer").getAttribute("aria-checked")).toBe(
      "true",
    ),
  );
  expect(screen.queryByRole("alertdialog")).toBe(null);
  expect(bodyOf(fetchMock, "/api/v1/agents/bayon-reviewer", "PATCH")).toEqual({
    enabled: true,
  });
});

test("an enable the server refuses says why beside the switch", async () => {
  renderIde("#/p/ws-bayon/agents", projectView({ agents: [REVIEWER] }), {
    "/api/v1/agents/bayon-reviewer": apiError(
      503,
      "db_busy",
      "the database is busy",
    ),
  });
  const user = userEvent.setup();
  const reviewer = await row("bayon-reviewer");
  await user.click(enabledSwitch("bayon-reviewer"));
  expect((await within(reviewer).findByRole("alert")).textContent).toBe(
    "Not enabled: db_busy: the database is busy",
  );
  expect(enabledSwitch("bayon-reviewer").getAttribute("aria-checked")).toBe(
    "false",
  );
});

test("max concurrency saves a whole number through PATCH, and refuses anything else before sending", async () => {
  const { routes } = server(projectView({ agents: [BUILDER] }));
  const fetchMock = renderIde("#/p/ws-bayon/agents", projectView(), routes);
  const user = userEvent.setup();
  const builder = await row("bayon-builder");
  const input = within(builder).getByRole("spinbutton", {
    name: "bayon-builder Max concurrency",
  });
  const set = within(builder).getByRole("button", { name: "Set" });
  expect((input as HTMLInputElement).value).toBe("1");
  expect(set.hasAttribute("disabled")).toBe(true);

  await user.clear(input);
  await user.type(input, "1.5");
  expect(within(builder).getByText("A whole number, 0 or more.")).toBeTruthy();
  expect(set.hasAttribute("disabled")).toBe(true);

  await user.clear(input);
  await user.type(input, "3");
  await user.click(set);
  await waitFor(() =>
    expect(bodyOf(fetchMock, "/api/v1/agents/bayon-builder", "PATCH")).toEqual({
      max_concurrency: 3,
    }),
  );
  await waitFor(() => expect(set.hasAttribute("disabled")).toBe(true));
  expect((input as HTMLInputElement).value).toBe("3");
});

test("Add agent lists each runner with its certification on local; a disabled runner cannot be picked", async () => {
  renderIde("#/p/ws-bayon/agents", projectView({ agents: [BUILDER] }), {
    "/api/v1/runners": runnersView([
      runnerView({ id: "runner-a" }),
      runnerView({ id: "runner-b", certifications: [] }),
      runnerView({
        id: "runner-c",
        certifications: [certification({ passed_at: null })],
      }),
      runnerView({
        id: "runner-d",
        certifications: [
          certification({
            decertified_at: 1_800_000_100_000,
            decertified_reason: "version changed",
          }),
        ],
      }),
      runnerView({ id: "runner-e", enabled: false }),
    ]),
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = await screen.findByRole("dialog");
  const runner = within(dialog).getByRole("combobox", { name: "Runner" });
  await waitFor(() => expect(runner.hasAttribute("disabled")).toBe(false));
  await user.click(runner);
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "runner-acertified on local",
    "runner-bnever run on local",
    "runner-cnot certified on local",
    "runner-ddecertified on local",
    "runner-edisabled: not offered",
  ]);
  expect(options[4]?.getAttribute("aria-disabled")).toBe("true");
});

test("Add agent POSTs kind, runner and max concurrency, warns of an uncertified pick, then shows the new agent", async () => {
  const { routes, add } = server(projectView({ agents: [BUILDER] }));
  const fetchMock = renderIde("#/p/ws-bayon/agents", projectView(), {
    ...routes,
    "/api/v1/runners": runnersView([
      runnerView({ id: "runner-a" }),
      runnerView({ id: "runner-b", certifications: [] }),
    ]),
    "/api/v1/projects/ws-bayon/agents": () =>
      add(
        projectAgent({
          id: "ws-bayon-reviewer-1",
          kind: "reviewer",
          runner_id: "runner-b",
          max_concurrency: 2,
        }),
      ),
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = await screen.findByRole("dialog");
  const addButton = within(dialog).getByRole("button", { name: "Add" });
  expect(addButton.hasAttribute("disabled")).toBe(true);

  await user.click(within(dialog).getByRole("combobox", { name: "Kind" }));
  await user.click(await screen.findByRole("option", { name: "reviewer" }));
  const runner = within(dialog).getByRole("combobox", { name: "Runner" });
  await waitFor(() => expect(runner.hasAttribute("disabled")).toBe(false));
  await user.click(runner);
  await user.click(await screen.findByRole("option", { name: /^runner-b/ }));
  expect(
    within(dialog).getByText(
      "warning: runner-b is not certified on local (never run): the agent is still added, but unattended work needs it certified.",
    ),
  ).toBeTruthy();
  await user.type(
    within(dialog).getByRole("spinbutton", {
      name: "Max concurrency (optional)",
    }),
    "2",
  );
  await user.click(addButton);

  await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
  expect(bodyOf(fetchMock, "/api/v1/projects/ws-bayon/agents", "POST")).toEqual(
    { kind: "reviewer", runner_id: "runner-b", max_concurrency: 2 },
  );
  // The dialog closes, and a toast names the agent it added.
  expect(
    await screen.findByRole("status", { name: "Added ws-bayon-reviewer-1" }),
  ).toBeTruthy();
  expect(await row("ws-bayon-reviewer-1")).toBeTruthy();
});

test("a refused add keeps the dialog open with the server's reason", async () => {
  renderIde("#/p/ws-bayon/agents", projectView({ agents: [BUILDER] }), {
    "/api/v1/runners": runnersView([runnerView({ id: "runner-a" })]),
    "/api/v1/projects/ws-bayon/agents": apiError(
      400,
      "validation",
      "runner runner-a is disabled",
    ),
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = await screen.findByRole("dialog");
  const runner = within(dialog).getByRole("combobox", { name: "Runner" });
  await waitFor(() => expect(runner.hasAttribute("disabled")).toBe(false));
  await user.click(runner);
  await user.click(await screen.findByRole("option", { name: /^runner-a/ }));
  await user.click(within(dialog).getByRole("button", { name: "Add" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Not added: validation: runner runner-a is disabled",
  );
  expect(screen.getByRole("dialog")).toBe(dialog);
});

test("Add agent offers an orchestrator; a second enabled one is refused in the server's words", async () => {
  const fetchMock = renderIde(
    "#/p/ws-bayon/agents",
    projectView({
      agents: [
        BUILDER,
        projectAgent({ id: "bayon-orchestrator", kind: "orchestrator" }),
      ],
    }),
    {
      "/api/v1/runners": runnersView([runnerView({ id: "runner-a" })]),
      "/api/v1/projects/ws-bayon/agents": apiError(
        409,
        "conflict",
        "project ws-bayon already has an enabled orchestrator, bayon-orchestrator: disable it before adding another",
      ),
    },
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(/at most one\s+enabled orchestrator/),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole("combobox", { name: "Kind" }));
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["builder", "reviewer", "orchestrator"]);
  await user.click(screen.getByRole("option", { name: "orchestrator" }));
  const runner = within(dialog).getByRole("combobox", { name: "Runner" });
  await waitFor(() => expect(runner.hasAttribute("disabled")).toBe(false));
  await user.click(runner);
  await user.click(await screen.findByRole("option", { name: /^runner-a/ }));
  await user.click(within(dialog).getByRole("button", { name: "Add" }));

  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Not added: conflict: project ws-bayon already has an enabled orchestrator, bayon-orchestrator: disable it before adding another",
  );
  expect(bodyOf(fetchMock, "/api/v1/projects/ws-bayon/agents", "POST")).toEqual(
    { kind: "orchestrator", runner_id: "runner-a" },
  );
  expect(screen.getByRole("dialog")).toBe(dialog);
});
