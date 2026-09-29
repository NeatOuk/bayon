import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { NewProjectScreen } from "@/projects/new-project-screen";
import { executorView, executorsView } from "@/test/executor-fixtures";
import { runnerView, runnersView } from "@/test/runner-fixtures";
import { bodyOf, callsTo, renderWithProviders, stubFetch } from "@/test/render";

// New project reads a https or ssh URL before creating anything: found with its default
// branch, or what is wrong and the one command that fixes it — and no create while it says no.

const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";
const CREATE = "/api/v1/projects";
const REPO_CHECK = "/api/v1/projects/repo-check";
const URL_ = "https://github.com/acme/shop.git";

const CREATED = {
  repo_id: "shop",
  workspace_id: "shop",
  builder_agent_id: "shop-builder",
  orchestrator_agent_id: null,
  reviewer_agent_id: null,
  submodule_repo_ids: [],
};

function render(check: unknown) {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
    [EXECUTORS]: executorsView([executorView({ id: "local" })]),
    [REPO_CHECK]: check,
    [CREATE]: CREATED,
  });
  renderWithProviders(<NewProjectScreen />);
  return { fetchMock, user: userEvent.setup() };
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Name"), "shop");
  await user.type(screen.getByLabelText("Repo URL"), URL_);
  await user.click(screen.getByRole("combobox", { name: "Runner" }));
  await user.click(await screen.findByRole("option", { name: "fixture" }));
}

test("leaving the URL field checks it, and a repository found says its default branch", async () => {
  const { fetchMock, user } = render({
    ok: true,
    outcome: "found",
    message: `Found ${URL_}. Its default branch is trunk.`,
    default_branch: "trunk",
    command: null,
  });
  await fill(user);
  expect(
    await screen.findByText(`Found ${URL_}. Its default branch is trunk.`),
  ).toBeTruthy();
  expect(bodyOf(fetchMock, REPO_CHECK, "POST")).toEqual({ repo_url: URL_ });
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByText("Project shop is ready.")).toBeTruthy();
  // The check already ran: Create does not ask again.
  expect(callsTo(fetchMock, REPO_CHECK, "POST")).toHaveLength(1);
});

test("a repository Bayon cannot read says why and the command that fixes it, and Create creates nothing", async () => {
  const command =
    "security add-generic-password -U -s foreman -a FORGE_TOKEN_GITHUB -w";
  const { fetchMock, user } = render({
    ok: false,
    outcome: "missing",
    message: `Bayon cannot read ${URL_}: the repository does not exist, or it is private and Bayon has no token for github.com.`,
    default_branch: null,
    command,
  });
  await fill(user);
  expect(
    await screen.findByText("Bayon cannot read this repository."),
  ).toBeTruthy();
  expect(screen.getByText(/it is private and Bayon has no token/)).toBeTruthy();
  expect(screen.getByText(command)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, REPO_CHECK, "POST")).toHaveLength(1),
  );
  expect(callsTo(fetchMock, CREATE, "POST")).toHaveLength(0);
});

test("a check the supervisor did not answer leaves Create to the server", async () => {
  const { fetchMock, user } = render({
    ok: false,
    outcome: null,
    message: "Bayon has not checked it: the supervisor did not answer.",
    default_branch: null,
    command: null,
  });
  await fill(user);
  expect(
    await screen.findByText("The repository was not checked."),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByText("Project shop is ready.")).toBeTruthy();
  expect(callsTo(fetchMock, CREATE, "POST")).toHaveLength(1);
});
