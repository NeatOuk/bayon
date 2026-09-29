import { NO_DELIVERY, NO_DOCS, NO_QA, type ProjectView } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";
import { bodyOf, callsTo } from "@/test/render";

// The Delivery section's push targets (migration 039): one field per repo, Detect fills them from
// each folder's origin and saves nothing, Save asks first and PATCHes only what changed, and a
// target core's shape rule refuses keeps Save off with the reason shown.

const HASH = "#/p/ws-bayon/settings";
const PROJECT = "/api/v1/projects/ws-bayon";
const DETECT = "/api/v1/projects/ws-bayon/push-targets/detect";
const JIRA = "/api/v1/projects/ws-bayon/jira";
const TOKEN = "/api/v1/jira";

const SUBMODULE_PROJECT: Partial<ProjectView> = {
  kind: "submodule",
  delivery: NO_DELIVERY,
  repos: [
    {
      id: "bayon-web",
      origin_url: "/src/bayon/web",
      push_url: null,
      rel_path: "bayon/web",
      submodule_path: "web",
      default_base_branch: "main",
    },
    {
      id: "bayon",
      origin_url: "/src/bayon",
      push_url: "git@forge.example:owner/bayon.git",
      rel_path: "bayon",
      submodule_path: null,
      default_base_branch: "main",
    },
  ],
};

const settings = (
  push_targets: readonly {
    repo_id: string;
    submodule_path: string | null;
    push_url: string | null;
  }[],
) => ({
  project: "ws-bayon",
  staff_approval: false,
  jira: null,
  qa: NO_QA,
  docs: NO_DOCS,
  delivery: NO_DELIVERY,
  push_targets,
  qa_ticket: null,
  changed: true,
});

const routes = (over: Record<string, unknown> = {}) => ({
  [JIRA]: { source: null, last_sync: null },
  [TOKEN]: {
    secret: "JIRA_API_TOKEN",
    store: "keychain",
    keychain: { service: "foreman", owner: true },
    present: true,
  },
  ...over,
});

// Its own settings section: the fields, and its Save and Detect in the footer.
const group = () => screen.findByRole("region", { name: "Push targets" });
const field = (g: HTMLElement, name: string) =>
  within(g).getByLabelText(`Push target for ${name}`) as HTMLInputElement;

afterEach(() => {
  window.location.hash = "";
});

test("each repo is listed, primary first, with its stored target and its origin", async () => {
  renderIde(HASH, projectView(SUBMODULE_PROJECT), routes());
  const g = await group();
  // In the DOM's order: the primary (listed second by the server) comes first.
  const values = within(g)
    .getAllByLabelText(/^Push target for /)
    .map((el) => (el as HTMLInputElement).value);
  expect(values).toEqual(["git@forge.example:owner/bayon.git", ""]);
  expect(field(g, "bayon").value).toBe("git@forge.example:owner/bayon.git");
  expect(field(g, "web").value).toBe("");
  expect(
    within(g).getByText("Blank pushes to its origin: /src/bayon/web"),
  ).toBeTruthy();
  // Nothing changed yet: nothing to save.
  expect(
    (
      within(g).getByRole("button", {
        name: "Save push targets",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("Detect fills the fields and shows each warning, and saves nothing", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView(SUBMODULE_PROJECT),
    routes({
      [DETECT]: {
        targets: [
          {
            repo_id: "bayon",
            submodule_path: null,
            push_url: "git@forge.example:owner/bayon.git",
            detected: "git@forge.example:owner/bayon.git",
            warning: null,
          },
          {
            repo_id: "bayon-web",
            submodule_path: "web",
            push_url: null,
            detected: "https://forge.example/owner/web.git",
            warning:
              "/src/bayon/web: its origin carried credentials; they were removed and not stored.",
          },
        ],
      },
    }),
  );
  const user = userEvent.setup();
  const g = await group();
  await user.click(
    within(g).getByRole("button", { name: "Detect from folder" }),
  );

  await waitFor(() =>
    expect(field(g, "web").value).toBe("https://forge.example/owner/web.git"),
  );
  expect(within(g).getByText(/carried credentials/)).toBeTruthy();
  expect(callsTo(fetchMock, DETECT, "POST")).toHaveLength(1);
  expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(0);
});

test("Save asks first: cancel sends nothing; confirmed, it PATCHes only the change", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView(SUBMODULE_PROJECT),
    routes({
      [PROJECT]: () =>
        settings([
          {
            repo_id: "bayon",
            submodule_path: null,
            push_url: "git@forge.example:owner/bayon.git",
          },
          {
            repo_id: "bayon-web",
            submodule_path: "web",
            push_url: "ssh://git@forge.example/owner/web.git",
          },
        ]),
    }),
  );
  const user = userEvent.setup();
  const g = await group();
  await user.type(field(g, "web"), "ssh://git@forge.example/owner/web.git");
  await user.click(
    within(g).getByRole("button", { name: "Save push targets" }),
  );

  const dialog = await screen.findByRole("alertdialog");
  expect(
    within(dialog).getByText(
      "bayon-web → ssh://git@forge.example/owner/web.git",
    ),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(0);

  await user.click(
    within(g).getByRole("button", { name: "Save push targets" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Save",
    }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    push_urls: [
      {
        repo_id: "bayon-web",
        push_url: "ssh://git@forge.example/owner/web.git",
      },
    ],
  });
  expect(
    await screen.findByRole("status", { name: "Saved the push targets" }),
  ).toBeTruthy();
});

test("clearing a target saves null: back to the origin", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView(SUBMODULE_PROJECT),
    routes({
      [PROJECT]: () =>
        settings([
          { repo_id: "bayon", submodule_path: null, push_url: null },
          { repo_id: "bayon-web", submodule_path: "web", push_url: null },
        ]),
    }),
  );
  const user = userEvent.setup();
  const g = await group();
  await user.clear(field(g, "bayon"));
  await user.click(
    within(g).getByRole("button", { name: "Save push targets" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(
    within(dialog).getByText("bayon → its origin (no push target)"),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
      push_urls: [{ repo_id: "bayon", push_url: null }],
    }),
  );
});

test.each([
  [
    "a local path",
    "/src/elsewhere",
    /must be an https:\/\/, ssh:\/\/ or git@host:path URL\./,
  ],
  [
    "a URL with a password",
    "https://me:pw@forge.example/o/r.git",
    /must not carry credentials/,
  ],
])("%s keeps Save off and says why", async (_what, typed, reason) => {
  const fetchMock = renderIde(HASH, projectView(SUBMODULE_PROJECT), routes());
  const user = userEvent.setup();
  const g = await group();
  await user.type(field(g, "web"), typed);
  expect(within(g).getByRole("alert").textContent).toMatch(reason);
  expect(
    (
      within(g).getByRole("button", {
        name: "Save push targets",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(0);
});
