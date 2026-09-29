// JiraSync against a temp-file DB and the local Jira fixture, never a real Jira: a
// capped result parks nothing, and a run that fails part-way keeps the pages it committed and the
// next run converges on them without a duplicate.
import {
  FakeClock,
  JIRA_TOKEN_SECRET,
  err,
  jiraFingerprint,
  ok,
} from "@bayon/core";
import { type Db } from "@bayon/db";
import {
  dumpAllRows,
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { JiraSyncRecord } from "@bayon/proto";
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
import { JiraSync, type JiraSyncDeps } from "./sync.js";
import type { JiraTokenStore } from "./token.js";

const JQL = "project = ACME";
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
      ],
    }),
  );
  fx.issues.clear();
  fx.queries.clear();
  fx.requests.length = 0;
  fx.overrides.length = 0;
  fx.loginOverrides.length = 0;
  fx.pageSize = 100;
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
        ? ok("sync-test-token-5c2e")
        : err({ class: "validation", message: name, retryable: false }),
  },
};

const syncWith = (o: Partial<JiraSyncDeps> = {}) =>
  new JiraSync({ db, token, fetch: fx.fetchVia(), timeoutMs: 5_000, ...o });

const issue = (n: number, o: Partial<FixtureIssue> = {}): FixtureIssue => ({
  id: String(30_000 + n),
  key: `ACME-${n}`,
  summary: `Issue ${n}`,
  ...o,
});
function query(...ns: number[]): void {
  for (const n of ns) fx.issues.set(issue(n).id, issue(n));
  fx.queries.set(
    JQL,
    ns.map((n) => issue(n).id),
  );
}

const Tickets = z.array(
  z.object({ origin_fingerprint: z.string().nullable(), status: z.string() }),
);
const tickets = async () =>
  Tickets.parse(unwrap(await dumpAllRows(db)).tickets).map((t) => [
    t.origin_fingerprint,
    t.status,
  ]);
const fp = (n: number) => jiraFingerprint(HOST, String(30_000 + n));

async function records() {
  return unwrap(await listAudit(db))
    .filter((a) => a.action === "jira.sync")
    .map((a) => JiraSyncRecord.parse(JSON.parse(a.payload_json ?? "null")));
}

test("a capped result parks nothing: a known unstarted ticket beyond the cap stays, and no id is looked up", async () => {
  query(1, 2, 3);
  expect(unwrap(await syncWith().run("shop", "rest"))).toMatchObject({
    created: 3,
    capped: false,
  });
  // Issue 3 has left the query (an uncapped run would park its ticket), and the query now matches
  // three issues, one more than this sync reads.
  query(1, 2, 4);
  fx.requests.length = 0;
  const capped = unwrap(await syncWith({ maxIssues: 2 }).run("shop", "rest"));
  expect(capped).toMatchObject({
    capped: true,
    parked: 0,
    unchanged: 2,
    created: 0,
  });
  expect(await tickets()).toEqual([
    [fp(1), "backlog"],
    [fp(2), "backlog"],
    [fp(3), "backlog"],
  ]);
  expect(fx.requests.some((r) => r.query.get("jql")?.startsWith("id in"))).toBe(
    false,
  );
  expect((await records()).at(-1)).toMatchObject({
    ok: true,
    capped: true,
    parked: 0,
  });
  // Uncapped, the same state parks it.
  expect(unwrap(await syncWith().run("shop", "rest"))).toMatchObject({
    capped: false,
    parked: 1,
    created: 1,
  });
});

test("matched counts every issue Jira returned, before the To Do filter; 0 when the query shows nothing", async () => {
  query(1, 2, 3);
  fx.issues.set(
    issue(2).id,
    issue(2, { status: "In Progress", category: "indeterminate" }),
  );
  fx.issues.set(issue(3).id, issue(3, { status: "Done", category: "done" }));
  expect(unwrap(await syncWith().run("shop", "rest"))).toMatchObject({
    matched: 3,
    created: 1,
    ignored: 2,
  });
  expect((await records()).at(-1)).toMatchObject({ ok: true, matched: 3 });

  // An account that sees nothing the query names: a success, with nothing matched.
  fx.queries.set(JQL, []);
  expect(unwrap(await syncWith().run("shop", "rest"))).toMatchObject({
    matched: 0,
    created: 0,
  });
  expect((await records()).at(-1)).toMatchObject({ ok: true, matched: 0 });
});

test("page 2 failing keeps page 1 committed; the next healthy run converges with no duplicate", async () => {
  query(1, 2, 3, 4);
  fx.pageSize = 2;
  const via = fx.fetchVia();
  let pages = 0;
  const failSecond: Fetch = (url, init) => {
    if (url.includes(SEARCH_PATH)) pages += 1;
    return pages === 2
      ? Promise.resolve(new Response("", { status: 500 }))
      : via(url, init);
  };
  const failed = await syncWith({ fetch: failSecond }).run("shop", "rest");
  expect(failed).toMatchObject({
    ok: false,
    error: { class: "runner_error", retryable: true },
  });
  expect(await tickets()).toEqual([
    [fp(1), "backlog"],
    [fp(2), "backlog"],
  ]);
  expect((await records()).at(-1)).toMatchObject({
    ok: false,
    matched: 2,
    created: 2,
    error: { class: "runner_error" },
  });

  const healed = unwrap(await syncWith().run("shop", "rest"));
  expect(healed).toMatchObject({
    created: 2,
    unchanged: 2,
    updated: 0,
    parked: 0,
    capped: false,
  });
  expect(await tickets()).toEqual([
    [fp(1), "backlog"],
    [fp(2), "backlog"],
    [fp(3), "backlog"],
    [fp(4), "backlog"],
  ]);
  const again = unwrap(await syncWith().run("shop", "rest"));
  expect(again).toMatchObject({ created: 0, unchanged: 4 });
  expect((await tickets()).length).toBe(4);
});

test("a throw anywhere in the run is a typed internal error, scrubbed and capped; its audit row is written and the lock let go", async () => {
  query(1);
  const poisoned = syncWith({
    map: () => {
      throw new Error(`poisoned issue sync-test-token-5c2e ${"y".repeat(900)}`);
    },
  });
  const run = await poisoned.run("shop", "timer");
  expect(run.ok).toBe(false);
  if (run.ok) return;
  expect(run.error).toMatchObject({ class: "internal", retryable: false });
  expect(run.error.message).toMatch(
    /^the Jira sync of shop failed unexpectedly: poisoned issue <redacted> y+…$/,
  );
  expect(run.error.message.length).toBeLessThanOrEqual(500);
  expect(poisoned.isRunning("shop")).toBe(false);
  expect((await records()).at(-1)).toMatchObject({
    via: "timer",
    ok: false,
    error: { class: "internal", message: run.error.message },
  });

  // A store that throws before any token is read is caught the same way.
  const broken = syncWith({
    token: {
      kind: "file",
      keychain: null,
      secrets: { get: () => Promise.reject(new Error("disk gone")) },
    },
  });
  expect(await broken.run("shop", "rest")).toMatchObject({
    ok: false,
    error: {
      class: "internal",
      message: "the Jira sync of shop failed unexpectedly: disk gone",
    },
  });
  expect(broken.isRunning("shop")).toBe(false);
  expect((await records()).map((r) => r.ok)).toEqual([false, false]);
});
