import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { NewProjectScreen } from "@/projects/new-project-screen";
import { QA_CREATE_LABEL } from "@/qa/qa-create-section";
import { executorView, executorsView } from "@/test/executor-fixtures";
import { bodyOf, renderWithProviders, stubFetch } from "@/test/render";
import { runnerView, runnersView } from "@/test/runner-fixtures";

// New project's QA section: off by default, and when it is on the request carries the
// same harness `PATCH /projects/:id` would take, checked by the same schemas the server runs.

const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";
const CREATE = "/api/v1/projects";

const CREATED = {
  repo_id: "demo",
  workspace_id: "demo",
  builder_agent_id: "demo-builder",
  orchestrator_agent_id: "demo-orchestrator",
  reviewer_agent_id: "demo-reviewer",
  submodule_repo_ids: [],
};

const routes = () => ({
  [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
  [EXECUTORS]: executorsView([executorView({ id: "local" })]),
  [CREATE]: CREATED,
});

type User = ReturnType<typeof userEvent.setup>;

const fillRequired = async (user: User) => {
  await user.type(screen.getByLabelText("Name"), "demo");
  await user.type(
    screen.getByLabelText("Repo URL"),
    "https://example.com/demo.git",
  );
  await user.click(screen.getByRole("combobox", { name: "Runner" }));
  await user.click(await screen.findByRole("option", { name: "fixture" }));
};

const qaSwitch = () => screen.getByRole("switch", { name: QA_CREATE_LABEL });
const createButton = () => screen.getByRole("button", { name: "Create" });

test("the QA section is off by default, and the request carries no qa", async () => {
  const fetchMock = stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  expect(qaSwitch().getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByLabelText("Command")).toBeNull();
  await fillRequired(user);
  await user.click(createButton());
  await screen.findByText(/is ready/);
  expect(bodyOf(fetchMock, CREATE, "POST")).not.toHaveProperty("qa");
});

test("on, the harness reaches the create request whole", async () => {
  const fetchMock = stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await user.click(qaSwitch());
  await user.click(screen.getByRole("radio", { name: /^Run a command/ }));
  // `{{` is userEvent's escape for a literal brace: the placeholder is typed, not a key press.
  await user.type(screen.getByLabelText("Command"), "make check {{ticket}");
  await user.type(screen.getByLabelText("Reports"), "reports/*.xml");
  await user.click(createButton());
  await screen.findByText(/is ready/);
  expect(bodyOf(fetchMock, CREATE, "POST")).toMatchObject({
    qa: {
      mode: "command",
      cmd: "make check {ticket}",
      reports: ["reports/*.xml"],
      secrets: [],
      junit: null,
      timeout_ms: null,
    },
  });
});

test("Create waits for a complete harness while the section is on", async () => {
  stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await user.click(qaSwitch());
  await user.click(screen.getByRole("radio", { name: /^Run a command/ }));
  await waitFor(() =>
    expect(createButton().hasAttribute("disabled")).toBe(true),
  );
  expect(screen.getByText(/Complete the harness/)).toBeTruthy();
  // A command with a shell character is refused here, exactly as the server refuses it.
  await user.type(screen.getByLabelText("Command"), "make check && ls");
  expect(screen.getByText(/is not an argv/)).toBeTruthy();
  expect(createButton().hasAttribute("disabled")).toBe(true);
  // …and a real one lets the create through.
  await user.clear(screen.getByLabelText("Command"));
  await user.type(screen.getByLabelText("Command"), "make check");
  await waitFor(() =>
    expect(createButton().hasAttribute("disabled")).toBe(false),
  );
});
