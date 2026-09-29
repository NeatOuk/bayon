import { NO_DELIVERY, NO_DOCS, NO_QA } from "@bayon/proto";
import type { JiraSourceView, ProjectJiraView } from "@bayon/proto";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { jiraKeychainCommand } from "@/jira/jira-token-step";
import { renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";
import { apiError, bodyOf, callsTo } from "@/test/render";
import { ticketsPage } from "@/test/ticket-fixtures";

/** The live install's command: these fixtures stand for the default home. */
const KEYCHAIN_COMMAND = jiraKeychainCommand("foreman");

// The IDE Tickets view's Jira strip: set a source with the New project form's fields,
// sync now and see what it did, edit or turn it off, and the token step when the API has no token.

const SITE = "https://acme.atlassian.net";
const JQL =
  'project = KITE AND statusCategory = "To Do" AND issuetype != Epic ORDER BY rank';
const SOURCE: JiraSourceView = { url: SITE, email: "me@acme.co", jql: JQL };
const HASH = "#/p/ws-bayon/tickets";
const JIRA = "/api/v1/projects/ws-bayon/jira";
const SYNC = "/api/v1/projects/ws-bayon/jira/sync";
const PROJECT = "/api/v1/projects/ws-bayon";
const TOKEN = "/api/v1/jira";
const BOARD = "/api/v1/tickets?workspace_id=ws-bayon&limit=100";
const MINUTE = 60_000;

const OFF = projectView({ jira: null });
const ON = projectView({ jira: SOURCE });

const record = (
  over: Partial<NonNullable<ProjectJiraView["last_sync"]>> = {},
): NonNullable<ProjectJiraView["last_sync"]> => ({
  via: "rest",
  ok: true,
  matched: 15,
  created: 2,
  updated: 1,
  unchanged: 5,
  parked: 3,
  ignored: 4,
  skipped: [],
  capped: false,
  at: Date.now() - 5 * MINUTE,
  ...over,
});

const settings = (jira: JiraSourceView | null) => ({
  project: "ws-bayon",
  staff_approval: false,
  jira,
  qa: NO_QA,
  docs: NO_DOCS,
  delivery: NO_DELIVERY,
  qa_ticket: null,
  changed: true,
});

const strip = () => screen.findByRole("region", { name: "Jira mirror" });

afterEach(() => {
  window.location.hash = "";
});

test("off: Mirror tickets from Jira opens the form, and Save PATCHes the source", async () => {
  let saved = false;
  const fetchMock = renderIde(HASH, OFF, {
    [BOARD]: ticketsPage([]),
    [JIRA]: () => ({ source: saved ? SOURCE : null, last_sync: null }),
    [PROJECT]: () => {
      saved = true;
      return settings(SOURCE);
    },
  });
  const user = userEvent.setup();
  const region = await strip();
  expect(
    await within(region).findByText("Not mirrored from Jira."),
  ).toBeTruthy();
  await user.click(
    within(region).getByRole("button", { name: "Mirror tickets from Jira" }),
  );
  const form = within(region).getByRole("form", { name: "Jira source" });
  const save = within(form).getByRole("button", { name: "Save" });
  expect(save.hasAttribute("disabled")).toBe(true);
  await user.type(
    within(form).getByLabelText("Jira site"),
    "ACME.atlassian.net",
  );
  await user.type(within(form).getByLabelText("Account email"), "me@acme.co");
  await user.type(within(form).getByLabelText("Jira project key"), "kite");
  await user.click(save);
  await waitFor(() =>
    expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({ jira: SOURCE }),
  );
  expect(await within(region).findByText("acme.atlassian.net")).toBeTruthy();
  expect(within(region).queryByRole("form")).toBeNull();
});

test("on: the site, the query in full on hover, and a link to the Jira project", async () => {
  const fetchMock = renderIde(HASH, ON, { [BOARD]: ticketsPage([]) });
  const region = await strip();
  expect(await within(region).findByText("acme.atlassian.net")).toBeTruthy();
  expect(within(region).getByText(JQL).getAttribute("title")).toBe(JQL);
  const link = within(region).getByRole("link", { name: /Open in Jira/ });
  expect(link.getAttribute("href")).toBe(`${SITE}/browse/KITE`);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  expect(within(region).getByText("Not synced yet.")).toBeTruthy();
  // The token is found: the strip says nothing of it.
  await waitFor(() => expect(callsTo(fetchMock, TOKEN)).toHaveLength(1));
  expect(within(region).queryByText("Jira API token")).toBeNull();
});

test("Sync now is pending while it runs, then shows the counts and refetches the board", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let synced = false;
  const fetchMock = renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [JIRA]: () => ({
      source: SOURCE,
      last_sync: synced
        ? record({ skipped: [{ key: "KITE-9", project: "ws-other" }] })
        : null,
    }),
    [SYNC]: async () => {
      await held;
      synced = true;
      return {
        project: "ws-bayon",
        matched: 15,
        created: 2,
        updated: 1,
        unchanged: 5,
        parked: 3,
        ignored: 4,
        skipped: [{ key: "KITE-9", project: "ws-other" }],
        capped: false,
      };
    },
  });
  const user = userEvent.setup();
  const region = await strip();
  await user.click(
    await within(region).findByRole("button", { name: "Sync now" }),
  );
  const pending = within(region).getByRole("button", { name: "Syncing…" });
  expect(pending.hasAttribute("disabled")).toBe(true);
  expect(pending.getAttribute("aria-busy")).toBe("true");
  const boardReads = callsTo(fetchMock, BOARD).length;
  release();
  const line = await within(region).findByText(
    /2 created · 1 updated · 3 parked · 4 ignored · 1 skipped/,
  );
  expect(line.textContent).toContain("Last sync 5 min ago (manual)");
  expect(line.getAttribute("title")).toContain("KITE-9 (ws-other)");
  expect(within(region).getByRole("button", { name: "Sync now" })).toBeTruthy();
  await waitFor(() =>
    expect(callsTo(fetchMock, BOARD).length).toBeGreaterThan(boardReads),
  );
});

test("a failed last sync says why, as an error", async () => {
  renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [JIRA]: {
      source: SOURCE,
      last_sync: record({
        via: "timer",
        ok: false,
        created: 0,
        updated: 0,
        parked: 0,
        ignored: 0,
        capped: true,
        error: {
          class: "validation",
          message: "Jira refused the token (401)",
          retryable: false,
        },
      }),
    },
  });
  const region = await strip();
  const alert = await within(region).findByRole("alert");
  expect(alert.textContent).toBe("It failed: Jira refused the token (401)");
  expect(alert.className).toContain("text-destructive");
  expect(within(region).getByText(/\(automatic\)/).textContent).toContain(
    "capped",
  );
});

const NOTHING_MATCHED =
  "Jira returned no issues for this query. Check that me@acme.co can see the project in Jira.";

test("a sync that worked but matched nothing says to check the account can see the project", async () => {
  renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [JIRA]: {
      source: SOURCE,
      last_sync: record({
        matched: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        parked: 0,
        ignored: 0,
      }),
    },
  });
  const region = await strip();
  expect(await within(region).findByText(NOTHING_MATCHED)).toBeTruthy();
  expect(within(region).queryByRole("alert")).toBeNull();
});

test.each([
  ["matched some issues", record({ matched: 1, created: 0, ignored: 1 })],
  [
    "failed",
    record({
      ok: false,
      matched: 0,
      created: 0,
      error: { class: "validation", message: "rejected", retryable: false },
    }),
  ],
  [
    "was kept before matched was",
    {
      via: "timer",
      ok: true,
      created: 0,
      updated: 0,
      unchanged: 3,
      parked: 0,
      ignored: 0,
      skipped: [],
      capped: false,
      at: Date.now() - MINUTE,
    },
  ],
])("a sync that %s has no matched-nothing note", async (_name, last) => {
  renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [JIRA]: { source: SOURCE, last_sync: last },
  });
  const region = await strip();
  expect(await within(region).findByText(/Last sync/)).toBeTruthy();
  expect(within(region).queryByText(NOTHING_MATCHED)).toBeNull();
});

test("a sync already running is a notice, not an error", async () => {
  renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [SYNC]: () =>
      Response.json(
        {
          error: {
            class: "conflict",
            message: "a Jira sync of project ws-bayon is already running",
            retryable: true,
          },
        },
        { status: 409 },
      ),
  });
  const user = userEvent.setup();
  const region = await strip();
  await user.click(
    await within(region).findByRole("button", { name: "Sync now" }),
  );
  expect(
    await within(region).findByText(/A sync is already running/),
  ).toBeTruthy();
  expect(within(region).queryByRole("alert")).toBeNull();
});

test("a sync refused before it ran shows the route's words", async () => {
  renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [SYNC]: () =>
      apiError(409, "conflict", "project ws-bayon has no Jira source"),
  });
  const user = userEvent.setup();
  const region = await strip();
  await user.click(
    await within(region).findByRole("button", { name: "Sync now" }),
  );
  expect((await within(region).findByRole("alert")).textContent).toBe(
    "Not synced: project ws-bayon has no Jira source",
  );
});

test("Edit reopens the form with the source; Turn off, confirmed, PATCHes null", async () => {
  let off = false;
  const fetchMock = renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [JIRA]: () => ({ source: off ? null : SOURCE, last_sync: record() }),
    [PROJECT]: () => {
      off = true;
      return settings(null);
    },
  });
  const user = userEvent.setup();
  const region = await strip();
  await user.click(await within(region).findByRole("button", { name: "Edit" }));
  const form = within(region).getByRole("form", { name: "Jira source" });
  expect(
    (within(form).getByLabelText("Jira site") as HTMLInputElement).value,
  ).toBe(SITE);
  expect(
    (within(form).getByLabelText("Jira project key") as HTMLInputElement).value,
  ).toBe("KITE");
  await user.click(within(form).getByRole("button", { name: "Cancel" }));
  await user.click(within(region).getByRole("button", { name: "Turn off" }));
  const ask = await screen.findByRole("alertdialog");
  expect(within(ask).getByText("Turn off the Jira mirror?")).toBeTruthy();
  expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(0);
  await user.click(
    within(ask).getByRole("button", { name: "Turn off mirror" }),
  );
  await waitFor(() =>
    expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({ jira: null }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    await within(region).findByText("Not mirrored from Jira."),
  ).toBeTruthy();
  // The confirm closed: a toast says what it did.
  expect(
    await screen.findByRole("status", { name: "The Jira mirror is off" }),
  ).toBeTruthy();
});

test("with no token stored, the strip shows the token step", async () => {
  renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [TOKEN]: {
      secret: "JIRA_API_TOKEN",
      store: "keychain",
      keychain: { service: "foreman", owner: true },
      present: false,
    },
  });
  const region = await strip();
  expect(await within(region).findByText(KEYCHAIN_COMMAND)).toBeTruthy();
  expect(
    within(region).getByRole("button", { name: "Check again" }),
  ).toBeTruthy();
});

test("a sync that could read the token re-checks it, and the step goes away", async () => {
  let present = false;
  renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [TOKEN]: () => ({
      secret: "JIRA_API_TOKEN",
      store: "keychain",
      keychain: { service: "foreman", owner: true },
      present,
    }),
    [SYNC]: () => {
      present = true;
      return {
        project: "ws-bayon",
        matched: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        parked: 0,
        ignored: 0,
        skipped: [],
        capped: false,
      };
    },
  });
  const user = userEvent.setup();
  const region = await strip();
  await within(region).findByText(KEYCHAIN_COMMAND);
  await user.click(within(region).getByRole("button", { name: "Sync now" }));
  await waitFor(() =>
    expect(within(region).queryByText(KEYCHAIN_COMMAND)).toBeNull(),
  );
});

test("two rapid clicks on Sync now send one POST, the button disabled while it runs", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchMock = renderIde(HASH, ON, {
    [BOARD]: ticketsPage([]),
    [SYNC]: async () => {
      await held;
      return {
        project: "ws-bayon",
        matched: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        parked: 0,
        ignored: 0,
        skipped: [],
        capped: false,
      };
    },
  });
  const region = await strip();
  const button = await within(region).findByRole("button", {
    name: "Sync now",
  });
  // Both before React re-renders the button: the second must not start a second sync.
  fireEvent.click(button);
  fireEvent.click(button);
  const pending = await within(region).findByRole("button", {
    name: "Syncing…",
  });
  expect(pending.hasAttribute("disabled")).toBe(true);
  fireEvent.click(pending);
  release();
  await within(region).findByRole("button", { name: "Sync now" });
  expect(callsTo(fetchMock, SYNC, "POST")).toHaveLength(1);
});
