import {
  DEFAULT_JIRA_PUSH_VIEW,
  NO_DELIVERY,
  NO_DOCS,
  NO_QA,
  type JiraPushView,
} from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { JIRA_PUSH_LABEL, checkPush } from "@/jira/jira-push-section";
import { renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";
import { apiError, bodyOf, callsTo } from "@/test/render";

// The Settings view's Jira updates: shown only while the project mirrors a Jira source;
// three optional status names offered from the site's own list; a comment switch; one PATCH that
// sends only the names given; and the note on the token's permissions.

const HASH = "#/p/ws-bayon/settings";
const PROJECT = "/api/v1/projects/ws-bayon";
const JIRA = "/api/v1/projects/ws-bayon/jira";
const STATUSES = "/api/v1/projects/ws-bayon/jira/statuses";
const TOKEN = "/api/v1/jira";
const SOURCE = {
  url: "https://example.atlassian.net",
  email: "someone@example.com",
  jql: "project = ABC",
};

const settings = (jira_push: JiraPushView) => ({
  project: "ws-bayon",
  staff_approval: false,
  jira: SOURCE,
  qa: NO_QA,
  docs: NO_DOCS,
  delivery: NO_DELIVERY,
  jira_push,
  qa_ticket: null,
  changed: true,
});

const routes = (over: Record<string, unknown> = {}) => ({
  [JIRA]: { source: SOURCE, last_sync: null },
  [TOKEN]: {
    secret: "JIRA_API_TOKEN",
    store: "keychain",
    keychain: { service: "foreman", owner: true },
    present: true,
  },
  ...over,
});

const form = () => screen.findByRole("form", { name: JIRA_PUSH_LABEL });

afterEach(() => {
  window.location.hash = "";
});

test("a project with no Jira source shows no Jira updates", async () => {
  renderIde(HASH, projectView({ jira: null }), {
    ...routes(),
    [JIRA]: { source: null, last_sync: null },
  });
  await screen.findByRole("region", { name: "Jira" });
  expect(screen.queryByRole("form", { name: JIRA_PUSH_LABEL })).toBeNull();
});

test("statuses load from Jira into the fields' list; Save sends only the names given", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ jira: SOURCE, jira_push: DEFAULT_JIRA_PUSH_VIEW }),
    routes({
      [STATUSES]: { statuses: ["Done", "In Progress", "In Review"] },
      [PROJECT]: () =>
        settings({
          status_map: { started: "In Progress", done: "Done" },
          comment_prs: false,
        }),
    }),
  );
  const user = userEvent.setup();
  const push = await form();
  expect(
    within(push)
      .getByText(/Transition Issues/)
      .closest("p")?.textContent,
  ).toMatch(/Transition Issues and Add Comments permissions/);

  await user.click(
    within(push).getByRole("button", { name: "Load statuses from Jira" }),
  );
  expect(await within(push).findByText("3 statuses offered.")).toBeTruthy();
  const started = within(push).getByLabelText("When work starts");
  const list = document.getElementById(started.getAttribute("list") ?? "");
  expect(
    [...(list?.querySelectorAll("option") ?? [])].map((o) => o.value),
  ).toEqual(["Done", "In Progress", "In Review"]);

  await user.type(started, "In Progress");
  await user.type(within(push).getByLabelText("When it is done"), " Done ");
  await user.click(
    within(push).getByRole("switch", { name: /Comment each pull request/ }),
  );
  await user.click(
    within(push).getByRole("button", { name: "Save Jira updates" }),
  );

  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    jira_push: {
      status_map: { started: "In Progress", done: "Done" },
      comment_prs: false,
    },
  });
  expect(
    await screen.findByRole("status", { name: "Saved the Jira updates" }),
  ).toBeTruthy();
});

test("statuses that cannot load say why", async () => {
  renderIde(
    HASH,
    projectView({ jira: SOURCE }),
    routes({
      [STATUSES]: () => apiError(400, "validation", "Jira refused the token"),
    }),
  );
  const user = userEvent.setup();
  const push = await form();
  await user.click(
    within(push).getByRole("button", { name: "Load statuses from Jira" }),
  );
  expect(await within(push).findByText(/Could not load statuses/)).toBeTruthy();
});

test("checkPush drops blanks and refuses a name too long", () => {
  expect(
    checkPush({
      names: { started: "  ", in_review: "In Review", done: "" },
      comment_prs: true,
    }),
  ).toEqual({ status_map: { in_review: "In Review" }, comment_prs: true });
  expect(
    checkPush({
      names: { started: "x".repeat(101), in_review: "", done: "" },
      comment_prs: true,
    }),
  ).toBeNull();
});
