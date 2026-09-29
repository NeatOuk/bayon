import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { DOCS_CREATE_LABEL } from "@/docs/docs-create-section";
import { JIRA_SECTION_LABEL } from "@/jira/jira-create-section";
import { NewProjectScreen } from "@/projects/new-project-screen";
import { executorView, executorsView } from "@/test/executor-fixtures";
import { bodyOf, renderWithProviders, stubFetch } from "@/test/render";
import { runnerView, runnersView } from "@/test/runner-fixtures";

// New project's Docs section: off by default, and when it is on the request carries the
// same source `PATCH /projects/:id` would take, checked by the same schemas the server runs. "Same
// as Jira" on this form means the Jira source the *same request* carries.

const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";
const CREATE = "/api/v1/projects";
const TOKEN = "/api/v1/jira";
const SYNC = "/api/v1/projects/demo/jira/sync";

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
  [TOKEN]: {
    secret: "JIRA_API_TOKEN",
    store: "keychain",
    keychain: { service: "foreman", owner: true },
    present: true,
  },
  [SYNC]: {
    project: "demo",
    matched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    parked: 0,
    ignored: 0,
    skipped: [],
    capped: false,
  },
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

const fillJira = async (user: User) => {
  await user.click(screen.getByRole("switch", { name: JIRA_SECTION_LABEL }));
  await user.type(screen.getByLabelText("Jira site"), "acme.atlassian.net");
  await user.type(screen.getByLabelText("Account email"), "op@acme.test");
  await user.type(screen.getByLabelText("Jira project key"), "kite");
};

const docsSwitch = () =>
  screen.getByRole("switch", { name: DOCS_CREATE_LABEL });
const createButton = () => screen.getByRole("button", { name: "Create" });

test("the Docs section is off by default, and the request carries no docs", async () => {
  const fetchMock = stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  expect(docsSwitch().getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByLabelText("Spaces")).toBeNull();
  await fillRequired(user);
  await user.click(createButton());
  await screen.findByText(/is ready/);
  expect(bodyOf(fetchMock, CREATE, "POST")).not.toHaveProperty("docs");
});

test("on, with Jira: the source reaches the create request with no site or account of its own", async () => {
  const fetchMock = stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await fillJira(user);
  await user.click(docsSwitch());
  await user.click(screen.getByRole("radio", { name: /^Confluence/ }));
  await user.type(screen.getByLabelText("Spaces"), "ONE\nTWO");
  await user.click(createButton());
  await screen.findByText(/is ready/);
  expect(bodyOf(fetchMock, CREATE, "POST")).toMatchObject({
    docs: {
      kind: "confluence",
      url: null,
      email: null,
      spaces: ["ONE", "TWO"],
    },
  });
});

test("on, without Jira: its own site and account reach the request", async () => {
  const fetchMock = stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await user.click(docsSwitch());
  await user.click(screen.getByRole("radio", { name: /^Confluence/ }));
  await user.type(
    screen.getByLabelText("Documentation site"),
    "acme.atlassian.net",
  );
  await user.type(
    screen.getByLabelText("Documentation account email"),
    "docs@acme.test",
  );
  await user.click(createButton());
  await screen.findByText(/is ready/);
  expect(bodyOf(fetchMock, CREATE, "POST")).toMatchObject({
    docs: {
      kind: "confluence",
      url: "https://acme.atlassian.net",
      email: "docs@acme.test",
      spaces: [],
    },
  });
});

test("Create waits for a complete source while the section is on", async () => {
  stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await user.click(docsSwitch());
  await user.click(screen.getByRole("radio", { name: /^Confluence/ }));
  await waitFor(() =>
    expect(createButton().hasAttribute("disabled")).toBe(true),
  );
  expect(screen.getByText(/Complete the documentation source/)).toBeTruthy();
  // A site that is not an Atlassian Cloud one is refused here, exactly as the server refuses it.
  await user.type(
    screen.getByLabelText("Documentation site"),
    "docs.evil.test",
  );
  expect(screen.getByText(/Atlassian Cloud site/)).toBeTruthy();
  expect(createButton().hasAttribute("disabled")).toBe(true);
});
