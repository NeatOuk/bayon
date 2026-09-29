import type { FolderCheck } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { localAddress } from "@/projects/folder-check";
import { NewProjectScreen } from "@/projects/new-project-screen";
import { executorView, executorsView } from "@/test/executor-fixtures";
import { runnerView, runnersView } from "@/test/runner-fixtures";
import { bodyOf, callsTo, renderWithProviders, stubFetch } from "@/test/render";

// A folder in New project: checked before anything is created; on the Bayon
// host the refusal is an action, anywhere else the command to run there; a folder with no commit is
// offered git init; and after either action the create goes on by itself.

const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";
const CREATE = "/api/v1/projects";
const CHECK = "/api/v1/folders/check";
const ALLOW = "/api/v1/folders/allow";
const INIT = "/api/v1/folders/init";
const PATH = "/Users/me/ttm";
const CREATED = {
  repo_id: "demo",
  workspace_id: "demo",
  builder_agent_id: "demo-build",
  orchestrator_agent_id: null,
  reviewer_agent_id: null,
  submodule_repo_ids: [],
  warnings: [],
};

const check = (o: Partial<FolderCheck>): FolderCheck => ({
  path: PATH,
  state: "ready",
  local: false,
  real_path: PATH,
  parent: null,
  branch: null,
  allow_command: `pnpm frm roots add ${PATH} --yes`,
  ...o,
});

/**
 * The folder as it is until an action succeeds, and as the action left it after: `before` for every
 * check (the one on leaving the field included) until `act` answers once.
 */
function folderThatChanges(
  before: FolderCheck,
  after: FolderCheck,
  answer: unknown,
) {
  let acted = false;
  return {
    check: () => (acted ? after : before),
    act: () => {
      acted = true;
      return answer;
    },
  };
}

function stub(routes: Readonly<Record<string, unknown>>) {
  return stubFetch({
    [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
    [EXECUTORS]: executorsView([executorView({ id: "local" })]),
    [CREATE]: CREATED,
    ...routes,
  });
}

async function fillAndCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Name"), "demo");
  await user.type(screen.getByLabelText("Repo URL"), PATH);
  await user.click(screen.getByRole("combobox", { name: "Runner" }));
  await user.click(await screen.findByRole("option", { name: "fixture" }));
  await user.click(screen.getByRole("button", { name: "Create" }));
}

test("on the Bayon host, a folder not allowed yet is an action: confirm, allow, then the create goes on", async () => {
  const folder = folderThatChanges(
    check({ state: "not_allowed", local: true, parent: "/Users/me" }),
    check({ state: "ready", local: true }),
    { root: PATH, roots: [PATH], changed: true },
  );
  const fetchMock = stub({ [CHECK]: folder.check, [ALLOW]: folder.act });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillAndCreate(user);
  expect(callsTo(fetchMock, CREATE, "POST")).toHaveLength(0);
  await user.click(
    await screen.findByRole("button", {
      name: "Allow agents to use this folder",
    }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(
    within(dialog).getByText(new RegExp(`in ${PATH} can read every file`)),
  ).toBeTruthy();
  expect(screen.queryByText(/pnpm frm roots add/)).toBeNull();
  await user.click(
    within(dialog).getByRole("button", {
      name: "Allow and create the project",
    }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, CREATE, "POST")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, ALLOW, "POST")).toEqual({
    path: PATH,
    scope: "folder",
    expect_root: PATH,
  });
  expect(await screen.findByText(/is ready\./)).toBeTruthy();
});

test("the parent may be allowed instead, and the confirm then names it", async () => {
  const folder = folderThatChanges(
    check({ state: "not_allowed", local: true, parent: "/Users/me/code" }),
    check({ state: "ready", local: true }),
    { root: "/Users/me/code", roots: ["/Users/me/code"], changed: true },
  );
  const fetchMock = stub({ [CHECK]: folder.check, [ALLOW]: folder.act });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillAndCreate(user);
  await user.click(
    await screen.findByRole("button", {
      name: "Allow agents to use this folder",
    }),
  );
  const dialog = await screen.findByRole("alertdialog");
  await user.click(
    within(dialog).getByRole("radio", { name: "/Users/me/code" }),
  );
  expect(
    within(dialog).getByText(/in \/Users\/me\/code can read/),
  ).toBeTruthy();
  await user.click(
    within(dialog).getByRole("button", {
      name: "Allow and create the project",
    }),
  );
  await waitFor(() =>
    expect(bodyOf(fetchMock, ALLOW, "POST")).toEqual({
      path: PATH,
      scope: "parent",
      expect_root: "/Users/me/code",
    }),
  );
});

test("from another machine, the refusal shows the command to run there, with Copy, and no allow action", async () => {
  const fetchMock = stub({
    [CHECK]: check({ state: "not_allowed", local: false, real_path: null }),
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillAndCreate(user);
  expect(
    await screen.findByText(`pnpm frm roots add ${PATH} --yes`),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "Copy the command that allows this folder",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Allow agents to use this folder" }),
  ).toBeNull();
  expect(callsTo(fetchMock, CREATE, "POST")).toHaveLength(0);
});

test.each([
  [
    "an empty folder",
    "not_repo_empty",
    /git init here and make one empty first commit on main\.$/,
  ],
  [
    "a folder with files",
    "not_repo_files",
    /Your files are not added or changed/,
  ],
  [
    "a repo with no commits",
    "no_commits",
    /one empty first commit on main\. Nothing you have written or staged/,
  ],
] as const)(
  "%s is offered git init, and the create goes on after it",
  async (_n, state, says) => {
    const ready = check({ state: "ready", branch: "main" });
    const folder = folderThatChanges(
      check({ state, branch: state === "no_commits" ? "main" : null }),
      ready,
      ready,
    );
    const fetchMock = stub({ [CHECK]: folder.check, [INIT]: folder.act });
    renderWithProviders(<NewProjectScreen />);
    const user = userEvent.setup();
    await fillAndCreate(user);
    expect(await screen.findByText(says)).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: "Initialise this folder as a git repository and create the project",
      }),
    );
    await waitFor(() =>
      expect(callsTo(fetchMock, CREATE, "POST")).toHaveLength(1),
    );
    expect(bodyOf(fetchMock, INIT, "POST")).toEqual({ path: PATH });
  },
);

test("an unborn HEAD beside other branches is explained, with no action", async () => {
  stub({
    [CHECK]: check({ state: "unborn_head", branch: "wip" }),
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillAndCreate(user);
  expect(
    await screen.findByText(/current branch, wip, has no commits yet/),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: /Initialise this folder/,
    }),
  ).toBeNull();
});

test("a .git that leads to another repository is explained, with no action", async () => {
  stub({ [CHECK]: check({ state: "foreign_repo" }) });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillAndCreate(user);
  expect(
    await screen.findByText(/belongs to another repository, or is broken/),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Initialise/ })).toBeNull();
});

test("the confirm says how to take it back, with frm roots remove", async () => {
  stub({
    [CHECK]: check({ state: "not_allowed", local: true, parent: null }),
  });
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillAndCreate(user);
  await user.click(
    await screen.findByRole("button", {
      name: "Allow agents to use this folder",
    }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(
    within(dialog).getByText(new RegExp(`pnpm frm roots remove ${PATH} --yes`)),
  ).toBeTruthy();
});

test("a url is never checked as a folder", async () => {
  const fetchMock = stub({});
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "demo");
  await user.type(
    screen.getByLabelText("Repo URL"),
    "https://example.com/d.git",
  );
  await user.click(screen.getByRole("combobox", { name: "Runner" }));
  await user.click(await screen.findByRole("option", { name: "fixture" }));
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, CREATE, "POST")).toHaveLength(1),
  );
  expect(callsTo(fetchMock, CHECK, "POST")).toHaveLength(0);
});

test("a page opened at a LAN address is told where it would count as on the host", () => {
  expect(
    localAddress({ hostname: "192.0.2.43", port: "5173", protocol: "http:" }),
  ).toBe("http://localhost:5173");
  expect(
    localAddress({ hostname: "localhost", port: "5173", protocol: "http:" }),
  ).toBeNull();
  expect(
    localAddress({ hostname: "127.0.0.1", port: "5173", protocol: "http:" }),
  ).toBeNull();
});
