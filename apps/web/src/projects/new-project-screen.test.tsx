import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { NewProjectScreen } from "@/projects/new-project-screen";
import { executorView, executorsView } from "@/test/executor-fixtures";
import { runnerView, runnersView } from "@/test/runner-fixtures";
import {
  apiError,
  bodyOf,
  renderWithProviders,
  stubFetch,
} from "@/test/render";

const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";
const CREATE = "/api/v1/projects";

const fillRequired = async (
  user: ReturnType<typeof userEvent.setup>,
  o: { readonly runner?: string; readonly executor?: string } = {},
) => {
  await user.type(screen.getByLabelText("Name"), "demo");
  await user.type(
    screen.getByLabelText("Repo URL"),
    "https://example.com/demo.git",
  );
  await user.click(screen.getByRole("combobox", { name: "Runner" }));
  await user.click(
    await screen.findByRole("option", { name: o.runner ?? "fixture" }),
  );
  if (o.executor !== undefined) {
    await user.click(screen.getByRole("combobox", { name: "Executor" }));
    await user.click(await screen.findByRole("option", { name: o.executor }));
  }
};

test("runner and executor selects are populated from GET /runners and GET /executors", async () => {
  stubFetch({
    [RUNNERS]: runnersView([
      runnerView({ id: "fixture" }),
      runnerView({ id: "critic" }),
    ]),
    [EXECUTORS]: executorsView([
      executorView({ id: "local" }),
      executorView({ id: "ctr-1" }),
    ]),
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Runner" }));
  expect(await screen.findByRole("option", { name: "fixture" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "critic" })).toBeTruthy();
  await user.click(screen.getByRole("option", { name: "fixture" }));
  await user.click(screen.getByRole("combobox", { name: "Executor" }));
  expect(await screen.findByRole("option", { name: "ctr-1" })).toBeTruthy();
});

test("Create is disabled until name, repo, runner and executor are all set", async () => {
  stubFetch({
    [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
    [EXECUTORS]: executorsView([executorView({ id: "local" })]),
  });
  renderWithProviders(<NewProjectScreen />);
  expect(
    screen.getByRole("button", { name: "Create" }).hasAttribute("disabled"),
  ).toBe(true);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "demo");
  await user.type(
    screen.getByLabelText("Repo URL"),
    "https://example.com/demo.git",
  );
  expect(
    screen.getByRole("button", { name: "Create" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.click(screen.getByRole("combobox", { name: "Runner" }));
  await user.click(await screen.findByRole("option", { name: "fixture" }));
  expect(
    screen.getByRole("button", { name: "Create" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("an uncertified pair shows a warning without blocking submit", async () => {
  stubFetch({
    [RUNNERS]: runnersView([runnerView({ id: "fixture", certifications: [] })]),
    [EXECUTORS]: executorsView([executorView({ id: "local" })]),
    [CREATE]: {
      repo_id: "demo",
      workspace_id: "demo",
      builder_agent_id: "demo-builder",
      orchestrator_agent_id: "demo-orchestrator",
      reviewer_agent_id: "demo-reviewer",
      submodule_repo_ids: [],
    },
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  expect(await screen.findByText(/not certified/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Create" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("a 400 refusal keeps the form and shows the server's message", async () => {
  stubFetch({
    [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
    [EXECUTORS]: executorsView([executorView({ id: "local" })]),
    [CREATE]: () =>
      apiError(
        400,
        "validation",
        "repo url must be https, ssh:// or user@host:path",
      ),
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await user.click(screen.getByRole("button", { name: "Create" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("repo url must be https");
  expect(screen.getByLabelText("Name")).toBeTruthy();
});

test("a 201 shows the created project's ids", async () => {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
    [EXECUTORS]: executorsView([executorView({ id: "local" })]),
    [CREATE]: {
      repo_id: "demo",
      workspace_id: "demo",
      builder_agent_id: "demo-builder",
      orchestrator_agent_id: "demo-orchestrator",
      reviewer_agent_id: "demo-reviewer",
      submodule_repo_ids: [],
    },
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user, { executor: "local" });
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(screen.getByText(/is ready/)).toBeTruthy());
  expect(screen.getByText(/demo-builder/)).toBeTruthy();
  expect(bodyOf(fetchMock, CREATE, "POST")).toMatchObject({
    name: "demo",
    repo_url: "https://example.com/demo.git",
    runner_id: "fixture",
    executor_id: "local",
    orchestrator: true,
    reviewer_runner_id: "fixture",
  });
});

test("a folder with submodules lists them once created", async () => {
  stubFetch({
    [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
    [EXECUTORS]: executorsView([executorView({ id: "local" })]),
    [CREATE]: {
      repo_id: "demo",
      workspace_id: "demo",
      builder_agent_id: "demo-builder",
      orchestrator_agent_id: null,
      reviewer_agent_id: null,
      submodule_repo_ids: ["demo-web", "demo-api"],
    },
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user, { executor: "local" });
  await user.click(screen.getByRole("button", { name: "Create" }));
  const list = await screen.findByRole("list", { name: "submodules" });
  expect(list.textContent).toContain("demo-web");
  expect(list.textContent).toContain("demo-api");
});

test("what creation noticed about a folder's remote is shown once created", async () => {
  stubFetch({
    [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
    [EXECUTORS]: executorsView([executorView({ id: "local" })]),
    [CREATE]: {
      repo_id: "demo",
      workspace_id: "demo",
      builder_agent_id: "demo-builder",
      orchestrator_agent_id: null,
      reviewer_agent_id: null,
      submodule_repo_ids: [],
      warnings: [
        "/src/demo: its origin carried credentials; they were removed and not stored.",
      ],
    },
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user, { executor: "local" });
  await user.click(screen.getByRole("button", { name: "Create" }));
  const list = await screen.findByRole("list", { name: "warnings" });
  expect(list.textContent).toContain("carried credentials");
});

test("a create with nothing to warn about shows no warnings", async () => {
  stubFetch({
    [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
    [EXECUTORS]: executorsView([executorView({ id: "local" })]),
    [CREATE]: {
      repo_id: "demo",
      workspace_id: "demo",
      builder_agent_id: "demo-builder",
      orchestrator_agent_id: null,
      reviewer_agent_id: null,
      submodule_repo_ids: [],
    },
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user, { executor: "local" });
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByText(/is ready\./)).toBeTruthy();
  expect(screen.queryByRole("list", { name: "warnings" })).toBeNull();
});
