// The quick pass against a temp-file DB and the local Jira fixture, never a real Jira:
// it reads the query narrowed to its window, files and updates tickets through the same page writer
// as a full run, and parks nothing, not even a ticket whose issue is missing from its result or has
// moved on; the full run after it parks those. Audited only when it wrote, never as `jira.sync`.
import {
  FakeClock,
  JIRA_TOKEN_SECRET,
  deltaJql,
  err,
  jiraFingerprint,
  ok,
} from "@bayon/core";
import { lastJiraSync, type Db } from "@bayon/db";
import {
  dumpAllRows,
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { JiraQuickSyncRecord } from "@bayon/proto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";
import { z } from "zod";
import type { Fetch } from "./client.js";
import {
  FIXTURE_SITE,
  SEARCH_PATH,
  startJiraFixture,
  type FixtureIssue,
  type JiraFixture,
} from "./fixtures.js";
import {
  JIRA_QUICK_ACTION,
  JIRA_QUICK_MAX_ISSUES,
  JiraSync,
  type JiraSyncDeps,
} from "./sync.js";
import type { JiraTokenStore } from "./token.js";

const JQL = "project = ACME ORDER BY rank ASC";
const DELTA = deltaJql(JQL, 2);
const HOST = "acme.atlassian.net";

let fx: JiraFixture;
beforeAll(async () => {
  fx = await startJiraFixture();
});
afterAll(async () => {
  await fx.close();
});

const opened: TempDb[] = [];
let db: Db;
const lines: string[] = [];
beforeEach(async () => {
  const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  opened.push(t);
  db = t.db;
  unwrap(
    await seedRows(db, {
      workspaces: [
        {
          id: "shop",
          name: "shop",
          kind: "single",
          jira_url: FIXTURE_SITE,
          jira_email: "op@acme.test",
          jira_jql: JQL,
        },
        { id: "plain", name: "plain", kind: "single" },
      ],
    }),
  );
  fx.issues.clear();
  fx.queries.clear();
  fx.requests.length = 0;
  fx.overrides.length = 0;
  fx.loginOverrides.length = 0;
  fx.pageSize = 100;
  lines.length = 0;
});
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

const token: JiraTokenStore = {
  kind: "keychain",
  keychain: { service: "foreman-0123456789ab", owner: false },
  secrets: {
    get: async (name) =>
      name === JIRA_TOKEN_SECRET
        ? ok("quick-test-token-7d1a")
        : err({ class: "validation", message: name, retryable: false }),
  },
};

const logger = {
  warn: (m: string) => void lines.push(m),
  error: (m: string) => void lines.push(m),
};

const syncWith = (o: Partial<JiraSyncDeps> = {}) =>
  new JiraSync({
    db,
    token,
    fetch: fx.fetchVia(),
    timeoutMs: 5_000,
    logger,
    ...o,
  });

const issue = (n: number, o: Partial<FixtureIssue> = {}): FixtureIssue => ({
  id: String(40_000 + n),
  key: `ACME-${n}`,
  summary: `Issue ${n}`,
  ...o,
});
const put = (...issues: FixtureIssue[]) => {
  for (const i of issues) fx.issues.set(i.id, i);
};
/** What the full query and the quick pass's window each match, as issue numbers. */
const matches = (jql: string, ...ns: number[]) =>
  fx.queries.set(
    jql,
    ns.map((n) => issue(n).id),
  );

const Tickets = z.array(
  z.object({
    origin_fingerprint: z.string().nullable(),
    title: z.string(),
    status: z.string(),
  }),
);
const tickets = async () =>
  Tickets.parse(unwrap(await dumpAllRows(db)).tickets).map((t) => [
    t.origin_fingerprint,
    t.title,
    t.status,
  ]);
const fp = (n: number) => jiraFingerprint(HOST, String(40_000 + n));
const searches = () =>
  fx.requests
    .filter((r) => r.path === SEARCH_PATH)
    .map((r) => r.query.get("jql"));
const actions = async () => unwrap(await listAudit(db)).map((a) => a.action);

test("it asks Jira for the project's query over the window, its ORDER BY kept last", async () => {
  unwrap(await syncWith().quick("shop", 2));
  expect(DELTA).toBe('(project = ACME) AND updated >= "-2m" ORDER BY rank ASC');
  expect(searches()).toEqual([DELTA]);
  unwrap(await syncWith().quick("shop", 16));
  expect(searches().at(-1)).toBe(
    '(project = ACME) AND updated >= "-16m" ORDER BY rank ASC',
  );
});

test("it files and updates, but parks neither an issue missing from its result nor one moved on; the full run after it parks both", async () => {
  put(issue(1), issue(2), issue(3));
  matches(JQL, 1, 2, 3);
  expect(unwrap(await syncWith().run("shop", "rest"))).toMatchObject({
    created: 3,
    parked: 0,
  });

  // In Jira since: 1 left the query (and so is not in the window either), 2 was edited, 3 moved to
  // In Progress, 4 is new. The window holds 2, 3 and 4.
  put(
    issue(2, { summary: "Issue 2, edited" }),
    issue(3, { status: "In Progress", category: "indeterminate" }),
    issue(4),
  );
  matches(JQL, 2, 3, 4);
  matches(DELTA, 2, 3, 4);
  fx.requests.length = 0;

  expect(unwrap(await syncWith().quick("shop", 2))).toEqual({
    project: "shop",
    window_minutes: 2,
    matched: 3,
    created: 1,
    updated: 1,
    unchanged: 0,
    ignored: 1,
    skipped: [],
    capped: false,
  });
  expect(await tickets()).toEqual([
    [fp(1), "Issue 1", "backlog"],
    [fp(2), "Issue 2, edited", "backlog"],
    [fp(3), "Issue 3", "backlog"],
    [fp(4), "Issue 4", "backlog"],
  ]);
  // Not even asked about: no lookup by id, the step that finds what departed.
  expect(searches()).toEqual([DELTA]);

  expect(unwrap(await syncWith().run("shop", "timer"))).toMatchObject({
    created: 0,
    updated: 0,
    unchanged: 2,
    parked: 2,
  });
  expect(await tickets()).toEqual([
    [fp(1), "Issue 1", "parked"],
    [fp(2), "Issue 2, edited", "backlog"],
    [fp(3), "Issue 3", "parked"],
    [fp(4), "Issue 4", "backlog"],
  ]);
});

test("it audits only what it wrote, as jira.quick_sync, never jira.sync: the last sync stays the full one", async () => {
  put(issue(1), issue(2));
  matches(JQL, 1, 2);
  unwrap(await syncWith().run("shop", "rest"));

  // Nothing changed in the window, then an unchanged issue in it: no row either time.
  matches(DELTA);
  expect(unwrap(await syncWith().quick("shop", 2))).toMatchObject({
    matched: 0,
  });
  matches(DELTA, 1);
  expect(unwrap(await syncWith().quick("shop", 2))).toMatchObject({
    matched: 1,
    unchanged: 1,
  });
  expect(await actions()).toEqual(["jira.sync"]);

  put(issue(2, { summary: "Issue 2, edited" }));
  matches(DELTA, 1, 2);
  unwrap(await syncWith().quick("shop", 2));
  const rows = unwrap(await listAudit(db));
  expect(rows.map((a) => a.action)).toEqual(["jira.sync", JIRA_QUICK_ACTION]);
  const row = rows[1];
  expect(row).toMatchObject({
    actor: "operator",
    target_kind: "project",
    target_id: "shop",
    workspace_id: "shop",
  });
  expect(
    JiraQuickSyncRecord.parse(JSON.parse(row?.payload_json ?? "")),
  ).toEqual({
    window_minutes: 2,
    ok: true,
    matched: 2,
    created: 0,
    updated: 1,
    unchanged: 1,
    ignored: 0,
    skipped: [],
    capped: false,
  });
  const last = unwrap(await lastJiraSync(db, "shop"));
  expect(JSON.parse(last?.payload_json ?? "")).toMatchObject({
    via: "rest",
    created: 2,
    parked: 0,
  });
});

test("a failure is returned, logged once per streak, and not audited when it wrote nothing", async () => {
  const fail = () => fx.overrides.push({ status: 500, body: "" });
  const sync = syncWith();
  fail();
  expect(await sync.quick("shop", 2)).toMatchObject({
    ok: false,
    error: { class: "runner_error", retryable: true },
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(
    /^quick jira pass of shop failed: runner_error: .*\(logged once until a quick pass works again; the full sync audits it\)$/,
  );
  // Failing again, every minute: no new line.
  fail();
  await sync.quick("shop", 2);
  fail();
  await sync.quick("shop", 2);
  expect(lines).toHaveLength(1);
  // It works again, then fails: a new streak, a new line.
  unwrap(await sync.quick("shop", 2));
  fail();
  await sync.quick("shop", 2);
  expect(lines).toHaveLength(2);
  expect(lines.join("\n")).not.toContain("quick-test-token-7d1a");
  expect(await actions()).toEqual([]);
});

test("a failure after a page it wrote is audited with what it wrote and the error", async () => {
  put(issue(1), issue(2));
  matches(DELTA, 1, 2);
  fx.pageSize = 1;
  const via = fx.fetchVia();
  let pages = 0;
  const failSecond: Fetch = (url, init) => {
    if (url.includes(SEARCH_PATH)) pages += 1;
    return pages === 2
      ? Promise.resolve(new Response("", { status: 500 }))
      : via(url, init);
  };
  expect(await syncWith({ fetch: failSecond }).quick("shop", 2)).toMatchObject({
    ok: false,
    error: { class: "runner_error" },
  });
  expect((await tickets()).map((t) => t[0])).toEqual([fp(1)]);
  const rows = unwrap(await listAudit(db));
  expect(rows.map((a) => a.action)).toEqual([JIRA_QUICK_ACTION]);
  expect(
    JiraQuickSyncRecord.parse(JSON.parse(rows[0]?.payload_json ?? "")),
  ).toMatchObject({
    ok: false,
    created: 1,
    error: { class: "runner_error", retryable: true },
  });
});

test("it reads at most five pages; past them it is capped and the rest wait for the full run", async () => {
  expect(JIRA_QUICK_MAX_ISSUES).toBe(500);
  put(issue(1), issue(2), issue(3));
  matches(DELTA, 1, 2, 3);
  expect(
    unwrap(await syncWith({ maxQuickIssues: 2 }).quick("shop", 2)),
  ).toMatchObject({ matched: 2, created: 2, capped: true });
  expect((await tickets()).map((t) => t[0])).toEqual([fp(1), fp(2)]);
});

test("one run per project, full or quick: each is refused while the other holds it", async () => {
  const via = fx.fetchVia();
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const gated: Fetch = async (url, init) => {
    await gate;
    return via(url, init);
  };
  const sync = syncWith({ fetch: gated });
  const full = sync.run("shop", "rest");
  expect(sync.isRunning("shop")).toBe(true);
  expect(await sync.quick("shop", 2)).toMatchObject({
    ok: false,
    error: { class: "conflict", retryable: true },
  });
  open();
  unwrap(await full);

  const quick = sync.quick("shop", 2);
  expect(await sync.run("shop", "rest")).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
  unwrap(await quick);
  expect(sync.isRunning("shop")).toBe(false);
});

test("refused before anything runs: a window that is not whole minutes, an unknown project, one with no source", async () => {
  for (const minutes of [0, -2, 1.5, Number.NaN]) {
    expect(await syncWith().quick("shop", minutes)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  }
  expect(await syncWith().quick("nope", 2)).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(await syncWith().quick("plain", 2)).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
  expect(fx.requests).toEqual([]);
  expect(await actions()).toEqual([]);
});
