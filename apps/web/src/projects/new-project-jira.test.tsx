import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { EMAIL_PROBLEM, SITE_PROBLEM } from "@/jira/jira-form";
import {
  FILE_STORE_COMMAND,
  jiraKeychainCommand,
  jiraKeychainLengthCommand,
} from "@/jira/jira-token-step";
import { NewProjectScreen } from "@/projects/new-project-screen";
import { executorView, executorsView } from "@/test/executor-fixtures";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";
import { runnerView, runnersView } from "@/test/runner-fixtures";

// New project's Jira section: off by default; on, a site normalised to
// https://<name>.atlassian.net, the account, a key that fills the query, the token step per host
// store, and one sync after the create that never holds the ready screen.

const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";
const CREATE = "/api/v1/projects";
const TOKEN = "/api/v1/jira";
const SYNC = "/api/v1/projects/demo/jira/sync";
const JQL =
  'project = KITE AND statusCategory = "To Do" AND issuetype != Epic ORDER BY rank';

const CREATED = {
  repo_id: "demo",
  workspace_id: "demo",
  builder_agent_id: "demo-builder",
  orchestrator_agent_id: "demo-orchestrator",
  reviewer_agent_id: "demo-reviewer",
  submodule_repo_ids: [],
};

const SYNCED = {
  project: "demo",
  matched: 3,
  created: 2,
  updated: 0,
  unchanged: 0,
  parked: 0,
  ignored: 1,
  skipped: [],
  capped: false,
};

/** The live install's service: `GET /jira` from an API on the default home. */
const OWNER = { service: "foreman", owner: true };
const KEYCHAIN_COMMAND = jiraKeychainCommand(OWNER.service);
const KEYCHAIN_LENGTH_COMMAND = jiraKeychainLengthCommand(OWNER.service);

const token = (
  store: "keychain" | "file",
  present: boolean,
  keychain: { service: string; owner: boolean } = OWNER,
) => ({
  secret: "JIRA_API_TOKEN",
  store,
  keychain: store === "file" ? null : keychain,
  present,
});

const routes = (extra: Readonly<Record<string, unknown>> = {}) => ({
  [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
  [EXECUTORS]: executorsView([executorView({ id: "local" })]),
  [CREATE]: CREATED,
  [TOKEN]: token("keychain", true),
  [SYNC]: SYNCED,
  ...extra,
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

const jiraSwitch = () =>
  screen.getByRole("switch", { name: "Mirror tickets from Jira" });

const fillJira = async (user: User) => {
  await user.type(screen.getByLabelText("Jira site"), "Acme-Co.atlassian.net/");
  await user.type(screen.getByLabelText("Account email"), "me@acme-co.com");
  await user.type(screen.getByLabelText("Jira project key"), "kite");
};

const createButton = () => screen.getByRole("button", { name: "Create" });

test("the Jira section is off by default, and the request carries no jira", async () => {
  const fetchMock = stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  expect(jiraSwitch().getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByLabelText("Jira site")).toBeNull();
  await fillRequired(user);
  await user.click(createButton());
  await screen.findByText(/is ready/);
  expect(bodyOf(fetchMock, CREATE, "POST")).not.toHaveProperty("jira");
  // Neither the token nor a sync was asked for.
  expect(callsTo(fetchMock, TOKEN)).toHaveLength(0);
  expect(callsTo(fetchMock, SYNC, "POST")).toHaveLength(0);
  expect(screen.queryByText(/Jira sync/)).toBeNull();
});

test("on, the site is normalised to its https origin, and a bad site or email says why", async () => {
  stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await user.click(jiraSwitch());
  const site = screen.getByLabelText("Jira site");
  await user.type(site, "Acme-Co.atlassian.net/");
  expect(screen.getByText("https://acme-co.atlassian.net")).toBeTruthy();
  expect(site.getAttribute("aria-invalid")).toBe("false");
  await user.clear(site);
  await user.type(site, "http://acme-co.atlassian.net");
  expect(screen.getByText(SITE_PROBLEM)).toBeTruthy();
  expect(site.getAttribute("aria-invalid")).toBe("true");
  expect(site.getAttribute("aria-describedby")).toContain(
    screen.getByText(SITE_PROBLEM).id,
  );
  await user.clear(site);
  await user.type(site, "https://acme-co.atlassian.net.attacker.com");
  expect(screen.getByText(SITE_PROBLEM)).toBeTruthy();
  const email = screen.getByLabelText("Account email");
  await user.type(email, "me at acme-co");
  expect(screen.getByText(EMAIL_PROBLEM)).toBeTruthy();
  expect(email.getAttribute("aria-invalid")).toBe("true");
});

test("the key fills the JQL under Advanced, until the JQL is edited", async () => {
  stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await user.click(jiraSwitch());
  const key = screen.getByLabelText("Jira project key");
  await user.type(key, "kite");
  expect((key as HTMLInputElement).value).toBe("KITE");
  await user.click(screen.getByRole("button", { name: "Advanced" }));
  const jql = await screen.findByLabelText("Query (JQL)");
  expect((jql as HTMLTextAreaElement).value).toBe(JQL);
  await user.clear(jql);
  await user.type(jql, "project = KITE AND reporter = currentUser()");
  await user.clear(key);
  await user.type(key, "ABC");
  expect((jql as HTMLTextAreaElement).value).toBe(
    "project = KITE AND reporter = currentUser()",
  );
});

test("Create waits for a complete source while the section is on", async () => {
  stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  expect(createButton().hasAttribute("disabled")).toBe(false);
  await user.click(jiraSwitch());
  expect(createButton().hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/or turn the mirror off/)).toBeTruthy();
  await fillJira(user);
  expect(createButton().hasAttribute("disabled")).toBe(false);
});

test("with the section on, the request carries jira and one sync follows the create", async () => {
  const fetchMock = stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await user.click(jiraSwitch());
  await fillJira(user);
  await user.click(createButton());
  await screen.findByText(/is ready/);
  expect(bodyOf(fetchMock, CREATE, "POST")).toMatchObject({
    name: "demo",
    jira: {
      url: "https://acme-co.atlassian.net",
      email: "me@acme-co.com",
      jql: JQL,
    },
  });
  await waitFor(() => expect(callsTo(fetchMock, SYNC, "POST")).toHaveLength(1));
  const status = await screen.findByText(/First Jira sync: 2 created/);
  expect(status.textContent).toContain("Open its Tickets to see them.");
  expect(within(status).queryByRole("link")).toBeNull();
});

/** The ready screen's links to the new project's tickets, by name and href. */
const ticketLinks = () =>
  screen
    .getAllByRole("link")
    .filter((link) => /tickets/i.test(link.textContent))
    .map((link) => [link.textContent, link.getAttribute("href")]);

test("created with Jira, the ready screen's one tickets link is the IDE's Tickets view", async () => {
  stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await user.click(jiraSwitch());
  await fillJira(user);
  await user.click(createButton());
  await screen.findByText(/First Jira sync/);
  expect(ticketLinks()).toEqual([["Open its Tickets", "#/p/demo/tickets"]]);
});

test("created without Jira, the ready screen keeps its link to the tickets board", async () => {
  stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await user.click(createButton());
  await screen.findByText(/is ready/);
  expect(ticketLinks()).toEqual([["Its tickets", "#/p/demo/tickets"]]);
  expect(screen.queryByRole("status")).toBeNull();
});

test("a first sync that fails leaves the project made and points at the Tickets view", async () => {
  stubFetch(
    routes({
      [SYNC]: () =>
        apiError(400, "validation", "JIRA_API_TOKEN could not be read"),
    }),
  );
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await fillRequired(user);
  await user.click(jiraSwitch());
  await fillJira(user);
  await user.click(createButton());
  expect(await screen.findByText(/is ready/)).toBeTruthy();
  expect(
    (await screen.findByText(/The first Jira sync did not finish\./))
      .textContent,
  ).toContain("Open its Tickets to see the last sync and what to fix.");
});

test("the token step: found", async () => {
  stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await user.click(jiraSwitch());
  expect(await screen.findByText("Token found")).toBeTruthy();
  expect(screen.queryByText(KEYCHAIN_COMMAND)).toBeNull();
  // The GUI never asks for the token itself.
  expect(screen.queryByRole("textbox", { name: /token/i })).toBeNull();
  expect(document.querySelector('input[type="password"]')).toBeNull();
});

test("the token step on the Keychain: its command, a copy button, the env alternative, and Check again", async () => {
  let present = false;
  const fetchMock = stubFetch(
    routes({ [TOKEN]: () => token("keychain", present) }),
  );
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await user.click(jiraSwitch());
  // From the clipboard, not the prompt that cuts it at 128; -U replaces one already stored.
  expect(
    screen.getByText(
      "Copy the token first, then run, for the Keychain · foreman (this install):",
    ),
  ).toBeTruthy();
  expect((await screen.findByText(KEYCHAIN_COMMAND)).textContent).toBe(
    'security add-generic-password -U -s foreman -a JIRA_API_TOKEN -w "$(pbpaste)"',
  );
  expect(screen.getByText(/-U replaces a token already stored/)).toBeTruthy();
  expect(screen.getByText(KEYCHAIN_LENGTH_COMMAND).textContent).toBe(
    "security find-generic-password -s foreman -a JIRA_API_TOKEN -w | wc -c",
  );
  expect(screen.getByText(/should print about 190, not 129/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Copy the length check" }),
  ).toBeTruthy();
  expect(
    screen.getByText(/FRM_SECRET_JIRA_API_TOKEN in the API's environment/),
  ).toBeTruthy();
  expect(
    screen.getByText(/id\.atlassian\.com → Security → API tokens/),
  ).toBeTruthy();
  expect(screen.getByText(/No restart needed/)).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "Copy the Keychain command" }),
  );
  expect(await screen.findByText("Copied.")).toBeTruthy();
  expect(await navigator.clipboard.readText()).toBe(KEYCHAIN_COMMAND);
  present = true;
  await user.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText("Token found")).toBeTruthy();
  expect(callsTo(fetchMock, TOKEN)).toHaveLength(2);
});

test("an API on another home: the commands name that home's own service, and say it is not ~/.foreman's", async () => {
  const other = { service: "foreman-0123456789ab", owner: false };
  stubFetch(routes({ [TOKEN]: token("keychain", false, other) }));
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await user.click(jiraSwitch());
  expect(
    (await screen.findByText(jiraKeychainCommand(other.service))).textContent,
  ).toBe(
    'security add-generic-password -U -s foreman-0123456789ab -a JIRA_API_TOKEN -w "$(pbpaste)"',
  );
  expect(
    screen.getByText(jiraKeychainLengthCommand(other.service)),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Copy the token first, then run, for the Keychain · foreman-0123456789ab (this home's own, not ~/.foreman's):",
    ),
  ).toBeTruthy();
  // Never the live install's service.
  expect(screen.queryByText(KEYCHAIN_COMMAND)).toBeNull();
});

test("the token step on the docker host's file store: its secrets.sh command", async () => {
  stubFetch(routes({ [TOKEN]: token("file", false) }));
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  await user.click(jiraSwitch());
  expect(await screen.findByText(FILE_STORE_COMMAND)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Copy the secrets command" }),
  ).toBeTruthy();
  expect(screen.queryByText(KEYCHAIN_COMMAND)).toBeNull();
  expect(screen.queryByText(/FRM_SECRET_JIRA_API_TOKEN/)).toBeNull();
});

/** Replaces `navigator.clipboard` (user-event installs a stub at setup) until `restore`. */
function withClipboard(clipboard: Partial<Clipboard> | undefined): () => void {
  const own = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
  return () => {
    if (own === undefined) Reflect.deleteProperty(navigator, "clipboard");
    else Object.defineProperty(navigator, "clipboard", own);
  };
}

test("with no clipboard (plain http on the LAN), Copy says why and to select the command", async () => {
  stubFetch(routes({ [TOKEN]: token("keychain", false) }));
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  const restore = withClipboard(undefined);
  try {
    await user.click(jiraSwitch());
    await user.click(
      await screen.findByRole("button", { name: "Copy the Keychain command" }),
    );
    expect(
      await screen.findByText(
        "Copying needs https or localhost: select the command and copy it.",
      ),
    ).toBeTruthy();
    // The command stays on the page, whole, to select by hand.
    expect(screen.getByText(KEYCHAIN_COMMAND)).toBeTruthy();
  } finally {
    restore();
  }
});

test("a clipboard that refuses the write says to select the command", async () => {
  stubFetch(routes({ [TOKEN]: token("file", false) }));
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  const restore = withClipboard({
    writeText: () => Promise.reject(new Error("denied")),
  });
  try {
    await user.click(jiraSwitch());
    await user.click(
      await screen.findByRole("button", { name: "Copy the secrets command" }),
    );
    expect(
      await screen.findByText(
        "Could not copy: select the command and copy it.",
      ),
    ).toBeTruthy();
  } finally {
    restore();
  }
});
