import {
  NO_DELIVERY,
  NO_DOCS,
  NO_QA,
  type DocsSourceView,
  type JiraSourceView,
  type QaConfigView,
} from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { perRepoHint } from "@/qa/qa-fields";
import { CI_TIMEOUT_PROBLEM, QA_CI_NEEDS_PR } from "@/qa/qa-form";
import { renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";
import { bodyOf, callsTo } from "@/test/render";

// The project IDE's Settings view: one screen where a project is
// configured. Its QA harness, its documentation source and its delivery each have a real section
// here; its Jira source is the strip's own form. No placeholder is left.

const HASH = "#/p/ws-bayon/settings";
const PROJECT = "/api/v1/projects/ws-bayon";
const JIRA = "/api/v1/projects/ws-bayon/jira";
const TOKEN = "/api/v1/jira";

const HARNESS: QaConfigView = {
  mode: "command",
  cmd: "./scripts/check {ticket}",
  timeout_ms: 600_000,
  secrets: ["QA_TOKEN"],
  reports: ["reports/*.xml"],
  junit: "reports/junit.xml",
  ci_checks: [],
  ci_timeout_ms: null,
};

const settings = (qa: QaConfigView, qaTicket: string | null = null) => ({
  project: "ws-bayon",
  staff_approval: false,
  jira: null,
  qa,
  docs: NO_DOCS,
  delivery: NO_DELIVERY,
  qa_ticket: qaTicket,
  changed: true,
});

const docsSettings = (docs: DocsSourceView) => ({
  project: "ws-bayon",
  staff_approval: false,
  jira: null,
  qa: NO_QA,
  docs,
  delivery: NO_DELIVERY,
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

const section = (name: string) => screen.findByRole("region", { name });

afterEach(() => {
  window.location.hash = "";
});

test("the view lists every section a project has, each of them configurable", async () => {
  renderIde(HASH, projectView(), routes());
  // The view's h1, and each section an h2 under it.
  expect(
    await screen.findByRole("heading", { level: 1, name: "Project settings" }),
  ).toBeTruthy();
  for (const name of [
    "Jira",
    "QA harness",
    "Docs",
    "Delivery",
    "Models",
    "Staffing",
  ]) {
    expect(await section(name), name).toBeTruthy();
    expect(
      within(await section(name)).getByRole("heading", { level: 2, name }),
    ).toBeTruthy();
  }
  // Nothing is a placeholder any more: every section takes a setting.
  expect(screen.queryByText(/not configurable yet/i)).toBeNull();
  // One card per concern: no card inside a section's card, and push targets are a
  // section of their own rather than a second form inside Delivery.
  const sections = document.querySelectorAll("[data-slot=settings-section]");
  for (const section of sections) {
    expect(
      section.querySelector("[data-slot=settings-section], [data-slot=card]"),
    ).toBeNull();
  }
  expect(await section("Push targets")).toBeTruthy();
});

test("a project with no harness shows the mode off, and the command fields hidden", async () => {
  renderIde(HASH, projectView({ qa: NO_QA }), routes());
  const qa = await section("QA harness");
  const off = within(qa).getByRole("radio", { name: /^No harness/ });
  // A base-ui radio: a button whose state is aria-checked.
  expect(off.getAttribute("aria-checked")).toBe("true");
  expect(within(qa).queryByLabelText("Command")).toBeNull();
});

test("choosing a command and saving PATCHes the whole harness", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ qa: NO_QA }),
    routes({ [PROJECT]: () => settings(HARNESS) }),
  );
  const user = userEvent.setup();
  const qa = await section("QA harness");
  await user.click(within(qa).getByRole("radio", { name: /^Run a command/ }));
  // `{{` is userEvent's escape for a literal brace: the placeholder is typed, not a key press.
  await user.type(
    within(qa).getByLabelText("Command"),
    "./scripts/check {{ticket}",
  );
  await user.type(within(qa).getByLabelText("Time limit (minutes)"), "10");
  await user.type(within(qa).getByLabelText("Secrets"), "QA_TOKEN");
  await user.type(within(qa).getByLabelText("Reports"), "reports/*.xml");
  await user.type(
    within(qa).getByLabelText("JUnit report"),
    "reports/junit.xml",
  );
  await user.click(
    within(qa).getByRole("button", { name: "Save QA settings" }),
  );

  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    qa: {
      mode: "command",
      cmd: "./scripts/check {ticket}",
      timeout_ms: 600_000,
      secrets: ["QA_TOKEN"],
      reports: ["reports/*.xml"],
      junit: "reports/junit.xml",
      ci_checks: [],
      ci_timeout_ms: null,
    },
  });
  expect(
    await screen.findByRole("status", { name: "QA settings saved" }),
  ).toBeTruthy();
});

// CI checks on the pull request as the QA source.
const PR_DELIVERY = {
  mode: "pull_request",
  when: "review_passed",
  close_on_merge: true,
} as const;

test("CI checks are refused inline, in the server's sentence, while delivery opens no pull request", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ qa: NO_QA, delivery: NO_DELIVERY }),
    routes({ [PROJECT]: () => settings(HARNESS) }),
  );
  const user = userEvent.setup();
  const qa = await section("QA harness");
  await user.click(
    within(qa).getByRole("radio", { name: /^CI checks on the pull request/ }),
  );
  expect(within(qa).getByRole("alert").textContent).toBe(QA_CI_NEEDS_PR);
  const save = within(qa).getByRole("button", { name: "Save QA settings" });
  expect(save.hasAttribute("disabled")).toBe(true);
  await user.click(save);
  expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(0);
});

test("with pull requests at review, CI checks save their required names and their wait", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ qa: NO_QA, delivery: PR_DELIVERY }),
    routes({ [PROJECT]: () => settings(HARNESS) }),
  );
  const user = userEvent.setup();
  const qa = await section("QA harness");
  await user.click(
    within(qa).getByRole("radio", { name: /^CI checks on the pull request/ }),
  );
  expect(within(qa).queryByRole("alert")).toBeNull();
  await user.type(within(qa).getByLabelText("Required checks"), "build, test");
  await user.type(within(qa).getByLabelText("Wait for CI (minutes)"), "30");
  await user.click(
    within(qa).getByRole("button", { name: "Save QA settings" }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    qa: {
      mode: "ci",
      cmd: null,
      timeout_ms: null,
      secrets: [],
      reports: [],
      junit: null,
      ci_checks: ["build", "test"],
      ci_timeout_ms: 1_800_000,
    },
  });
});

test("with several repos, the required checks say how to name one repo's check, and a prefix that is no repo is refused", async () => {
  const repo = (id: string) => ({
    id,
    origin_url: `/src/${id}`,
    push_url: null,
    rel_path: id,
    submodule_path: id === "web" ? null : id,
    default_base_branch: "main",
  });
  const fetchMock = renderIde(
    HASH,
    projectView({
      qa: NO_QA,
      delivery: PR_DELIVERY,
      repos: [repo("web"), repo("api")],
    }),
    routes({ [PROJECT]: () => settings(HARNESS) }),
  );
  const user = userEvent.setup();
  const qa = await section("QA harness");
  await user.click(
    within(qa).getByRole("radio", { name: /^CI checks on the pull request/ }),
  );
  expect(within(qa).getByText(perRepoHint(["web", "api"]))).toBeTruthy();
  await user.type(within(qa).getByLabelText("Required checks"), "lint:eslint");
  expect(
    await within(qa).findByText(/“lint:eslint” reads as repo “lint”/),
  ).toBeTruthy();
  const save = within(qa).getByRole("button", { name: "Save QA settings" });
  expect(save.hasAttribute("disabled")).toBe(true);
  await user.clear(within(qa).getByLabelText("Required checks"));
  await user.type(
    within(qa).getByLabelText("Required checks"),
    "api:lint:eslint",
  );
  await user.click(save);
  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toMatchObject({
    qa: { mode: "ci", ci_checks: ["api:lint:eslint"] },
  });
});

test("a CI wait past six hours is refused before it is sent", async () => {
  renderIde(HASH, projectView({ qa: NO_QA, delivery: PR_DELIVERY }), routes());
  const user = userEvent.setup();
  const qa = await section("QA harness");
  await user.click(
    within(qa).getByRole("radio", { name: /^CI checks on the pull request/ }),
  );
  await user.type(within(qa).getByLabelText("Wait for CI (minutes)"), "400");
  expect(await within(qa).findByText(CI_TIMEOUT_PROBLEM)).toBeTruthy();
  expect(
    within(qa)
      .getByRole("button", { name: "Save QA settings" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

// The form runs the server's own schemas, so a command with a shell character never reaches it.
test("a command that is not an argv is refused before it is sent", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ qa: NO_QA }),
    routes({ [PROJECT]: () => settings(HARNESS) }),
  );
  const user = userEvent.setup();
  const qa = await section("QA harness");
  await user.click(within(qa).getByRole("radio", { name: /^Run a command/ }));
  await user.type(within(qa).getByLabelText("Command"), "make check && ls");
  expect(await within(qa).findByText(/is not an argv/)).toBeTruthy();
  const save = within(qa).getByRole("button", { name: "Save QA settings" });
  expect(save.hasAttribute("disabled")).toBe(true);
  await user.click(save);
  expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(0);
});

test("“Bayon builds one” saves the mode and names the ticket it filed", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ qa: NO_QA }),
    routes({
      [PROJECT]: () =>
        settings({ ...NO_QA, mode: "pending" }, "an earlier change"),
    }),
  );
  const user = userEvent.setup();
  const qa = await section("QA harness");
  await user.click(
    within(qa).getByRole("radio", { name: /^Bayon builds one/ }),
  );
  await user.click(
    within(qa).getByRole("button", { name: "Save QA settings" }),
  );

  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toMatchObject({
    qa: { mode: "pending", cmd: null },
  });
  // The toast names the ticket it filed.
  const saved = await screen.findByRole("status", {
    name: "QA settings saved",
  });
  expect(saved.textContent).toContain(
    "an earlier change asks an agent to build the harness",
  );
});

test("a stored harness comes back into the form to edit", async () => {
  renderIde(HASH, projectView({ qa: HARNESS }), routes());
  const qa = await section("QA harness");
  expect(
    within(qa)
      .getByRole("radio", { name: /^Run a command/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect((within(qa).getByLabelText("Command") as HTMLInputElement).value).toBe(
    HARNESS.cmd,
  );
  expect(
    (within(qa).getByLabelText("Time limit (minutes)") as HTMLInputElement)
      .value,
  ).toBe("10");
  expect(
    (within(qa).getByLabelText("Secrets") as HTMLTextAreaElement).value,
  ).toBe("QA_TOKEN");
});

// The documentation source. Its "same as Jira" default is the whole of what is not a
// plain form: it sends no site and no account, and the server fills both in.

const JIRA_SOURCE: JiraSourceView = {
  url: "https://acme.atlassian.net",
  email: "op@acme.test",
  jql: "project = ACME",
};

const DOCS: DocsSourceView = {
  kind: "confluence",
  url: JIRA_SOURCE.url,
  email: JIRA_SOURCE.email,
  spaces: ["ONE"],
};

test("a project with no docs source shows the kind off, and no site fields", async () => {
  renderIde(HASH, projectView(), routes());
  const docs = await section("Docs");
  expect(
    within(docs)
      .getByRole("radio", { name: /^No documentation source/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(within(docs).queryByLabelText("Spaces")).toBeNull();
});

test("same as Jira: turning the source on sends no site and no account, and says whose it uses", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ jira: JIRA_SOURCE }),
    routes({ [PROJECT]: () => docsSettings(DOCS) }),
  );
  const user = userEvent.setup();
  const docs = await section("Docs");
  await user.click(within(docs).getByRole("radio", { name: /^Confluence/ }));
  // It reads the project's Jira site and account, and says so instead of asking again.
  expect(within(docs).getByText(/acme\.atlassian\.net as op@acme\.test/));
  expect(within(docs).queryByLabelText("Documentation site")).toBeNull();
  await user.type(within(docs).getByLabelText("Spaces"), "ONE");
  await user.click(
    within(docs).getByRole("button", { name: "Save docs settings" }),
  );

  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    docs: { kind: "confluence", url: null, email: null, spaces: ["ONE"] },
  });
  expect(
    await screen.findByRole("status", { name: "Docs settings saved" }),
  ).toBeTruthy();
});

test("a mixed-case space key is sent as typed: Confluence Cloud keys can be mixed case", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ jira: JIRA_SOURCE }),
    routes({ [PROJECT]: () => docsSettings(DOCS) }),
  );
  const user = userEvent.setup();
  const docs = await section("Docs");
  await user.click(within(docs).getByRole("radio", { name: /^Confluence/ }));
  await user.type(within(docs).getByLabelText("Spaces"), "Docs{Enter}ops_2");
  expect(within(docs).queryByText(/A space key/)).toBeNull();
  await user.click(
    within(docs).getByRole("button", { name: "Save docs settings" }),
  );

  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    docs: {
      kind: "confluence",
      url: null,
      email: null,
      spaces: ["Docs", "ops_2"],
    },
  });
});

test("a site of its own overrides Jira's, and a space key that is not one is refused before it is sent", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ jira: JIRA_SOURCE }),
    routes({ [PROJECT]: () => docsSettings(DOCS) }),
  );
  const user = userEvent.setup();
  const docs = await section("Docs");
  await user.click(within(docs).getByRole("radio", { name: /^Confluence/ }));
  await user.click(
    within(docs).getByRole("switch", { name: /Same site and account as Jira/ }),
  );
  // Turning it off starts from Jira's, so nothing is retyped.
  expect(
    (within(docs).getByLabelText("Documentation site") as HTMLInputElement)
      .value,
  ).toBe(JIRA_SOURCE.url);

  await user.type(within(docs).getByLabelText("Spaces"), "not a key");
  expect(
    await within(docs).findByText(
      "not a key: A space key: letters, digits and underscores, like DOCS or Docs",
    ),
  ).toBeTruthy();
  const save = within(docs).getByRole("button", { name: "Save docs settings" });
  expect(save.hasAttribute("disabled")).toBe(true);
  await user.click(save);
  expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(0);
});

test("a project with no Jira source cannot copy one: it says so instead of sending a half source", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView(),
    routes({ [PROJECT]: () => docsSettings(DOCS) }),
  );
  const user = userEvent.setup();
  const docs = await section("Docs");
  await user.click(within(docs).getByRole("radio", { name: /^Confluence/ }));
  // With no Jira source the switch starts off and the fields are asked for instead.
  const same = within(docs).getByRole("switch", {
    name: /Same site and account as Jira/,
  });
  expect(same.getAttribute("aria-checked")).toBe("false");
  expect(within(docs).getByLabelText("Documentation site")).toBeTruthy();
  // Turned on anyway, it says there is nothing to copy rather than sending half a source.
  await user.click(same);
  expect(await within(docs).findByText(/no Jira source/i)).toBeTruthy();
  const save = within(docs).getByRole("button", { name: "Save docs settings" });
  expect(save.hasAttribute("disabled")).toBe(true);
  await user.click(save);
  expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(0);
});

test("a stored source comes back into the form to edit", async () => {
  renderIde(
    HASH,
    projectView({
      jira: JIRA_SOURCE,
      docs: { ...DOCS, spaces: ["ONE", "TWO"] },
    }),
    routes(),
  );
  const docs = await section("Docs");
  expect(
    within(docs)
      .getByRole("radio", { name: /^Confluence/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    (within(docs).getByLabelText("Spaces") as HTMLTextAreaElement).value,
  ).toBe("ONE\nTWO");
  // Its site and account are the project's Jira ones, so it reads as "same as Jira".
  expect(
    (
      within(docs).getByRole("switch", {
        name: /Same site and account as Jira/,
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
  ).toBe("true");
});
