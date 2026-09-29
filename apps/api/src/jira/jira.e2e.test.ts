// A project's Jira mirror over HTTP against a temp-file DB and a local Jira fixture,
// never a real Jira: the source set on create and on PATCH (and refused for any site but
// Atlassian's), a sync that files, updates, ignores and parks, idempotent on a replay, one
// `jira.sync` audit row per run in the project's timeline, 404 and both 409s, a refused token, and
// the token itself in no row, no response body and no log line.
import {
  JIRA_TOKEN_SECRET,
  err,
  jiraFingerprint,
  mapIssue,
  ok,
  systemClock,
  FakeClock,
  NO_STEP_TIERS,
} from "@bayon/core";
import { findTicketByFingerprint, openDb, type Db } from "@bayon/db";
import {
  dumpAllRows,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import type { SecretStore } from "@bayon/executors";
import {
  DEFAULT_JIRA_PUSH_VIEW,
  NO_DELIVERY,
  NO_DOCS,
  NO_QA,
  ApiErrorBody,
  AuditPage,
  JiraSyncRecord,
  JiraSyncResult,
  JiraTokenStatus,
  ProjectJiraView,
  ProjectSettingsState,
  ProjectsView,
  TimelinePage,
} from "@bayon/proto";
import type { LoggerService } from "@nestjs/common";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { dbStore } from "../db-store.js";
import { HistoryService } from "../history/history-service.js";
import { ProjectsService } from "../projects/projects-service.js";
import { startApi, type RunningApi } from "../server.js";
import type { Fetch } from "./client.js";
import {
  FIXTURE_SITE,
  LOGIN_PATH,
  startJiraFixture,
  type FixtureIssue,
  type JiraFixture,
} from "./fixtures.js";
import { JiraService } from "./service.js";
import { JiraSync } from "./sync.js";
import type { JiraTokenStore, SecretStoreKind } from "./token.js";

const TOKEN = "e2e-jira-token-9b7d3c1a5f";
const BEARER = "e2e-jira-0123456789abcdef";
const EMAIL = "op@acme.test";
const BASIC_B64 = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
const JQL = "project = ACME ORDER BY rank";
const SOURCE = { url: FIXTURE_SITE, email: EMAIL, jql: JQL };
const HOST = "acme.atlassian.net";

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
let fx: JiraFixture;

/** Every line anything logged: Nest's logger and the sync's own. */
const lines: string[] = [];
/** Every response body the tests read. */
const bodies: string[] = [];
/** The token is in the host store only while this is true. */
let tokenStored = true;
/** While true, mapping an issue throws (with the token in its message): a poisoned issue. */
let poisoned = false;
/** While set, the sync's next request waits here: a sync held in flight. */
let hold: { entered: () => void; release: Promise<void> } | null = null;

const capture = (...parts: unknown[]) =>
  void lines.push(
    parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(" "),
  );
const nestLogger: LoggerService = {
  log: capture,
  error: capture,
  warn: capture,
  debug: capture,
  verbose: capture,
  fatal: capture,
};

const secrets: SecretStore = {
  get: async (name) =>
    tokenStored && name === JIRA_TOKEN_SECRET
      ? ok(TOKEN)
      : err({
          class: "validation",
          message: `secret ${name} is not in the secret store`,
          retryable: false,
        }),
};

/** A non-default home's Keychain service: what a test's API reads, never `foreman`. */
const SCRATCH_KEYCHAIN = { service: "foreman-0123456789ab", owner: false };
/** Which host store the fake stands for: the Mac's Keychain, or the docker host's files. */
let kind: SecretStoreKind = "keychain";
const token: JiraTokenStore = {
  get kind() {
    return kind;
  },
  get keychain() {
    return kind === "file" ? null : SCRATCH_KEYCHAIN;
  },
  secrets,
};

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 1));
  unwrap(
    await seedRows(spine.db, {
      workspaces: [
        { id: "shop", name: "shop", kind: "single" },
        { id: "blog", name: "blog", kind: "single" },
      ],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  fx = await startJiraFixture();
  const via = fx.fetchVia();
  const fetchHeld: Fetch = async (url, init) => {
    const held = hold;
    if (held !== null) {
      hold = null;
      held.entered();
      await held.release;
    }
    return via(url, init);
  };
  const sync = new JiraSync({
    db: apiDb,
    token,
    fetch: fetchHeld,
    timeoutMs: 5_000,
    map: (issue, site) => {
      if (poisoned) throw new Error(`poisoned issue ${issue.key} ${TOKEN}`);
      return mapIssue(issue, site);
    },
    logger: { warn: capture, error: capture },
  });
  api = await startApi({
    config: { token: BEARER, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: nestLogger,
    projects: new ProjectsService({
      db: apiDb,
      clock: systemClock,
      mirrorsRoot: "/home/frm/mirrors",
    }),
    history: new HistoryService({ db: apiDb, clock: systemClock }),
    jira: new JiraService({ db: apiDb, sync, token }),
  });
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  await fx?.close();
  spine?.cleanup();
});

async function http(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly json: unknown }> {
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${BEARER}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: text === "" ? null : JSON.parse(text) };
}

const errorOf = (json: unknown) => ApiErrorBody.parse(json).error;
const sync = (project: string) =>
  http("POST", `/projects/${project}/jira/sync`);

const issue = (n: number, o: Partial<FixtureIssue> = {}): FixtureIssue => ({
  id: String(20_000 + n),
  key: `ACME-${n}`,
  summary: `Issue ${n}`,
  ...o,
});
const put = (...issues: FixtureIssue[]) => {
  for (const i of issues) fx.issues.set(i.id, i);
};
const ticketOf = async (n: number) =>
  unwrap(
    await findTicketByFingerprint(
      apiDb,
      jiraFingerprint(HOST, String(20_000 + n)),
    ),
  );

/** Project `project`'s jira.sync rows, newest first, as its timeline serves them. */
async function syncRows(project: string) {
  const page = TimelinePage.parse(
    (
      await http(
        "GET",
        `/projects/${project}/timeline?kind=audit.jira.sync&limit=100`,
      )
    ).json,
  );
  return page.items.map((i) => JiraSyncRecord.parse(i.payload));
}

const TicketEvents = z.array(
  z.object({
    ticket_id: z.string(),
    kind: z.string(),
    reason: z.string().nullable(),
    to_status: z.string().nullable(),
  }),
);

test("the doors need the operator's bearer", async () => {
  for (const [method, path] of [
    ["GET", "/projects/blog/jira"],
    ["POST", "/projects/blog/jira/sync"],
  ] as const) {
    const res = await fetch(`${api.url}${path}`, { method });
    expect(res.status, path).toBe(401);
  }
});

test("an unknown project is 404 on every door", async () => {
  for (const [method, path] of [
    ["GET", "/projects/nobody/jira"],
    ["POST", "/projects/nobody/jira/sync"],
    ["GET", "/projects/nobody/jira/statuses"],
  ] as const) {
    const res = await http(method, path);
    expect(res.status, path).toBe(404);
    expect(errorOf(res.json).class).toBe("not_found");
  }
});

test("a project without a source: GET shows none, a sync is 409 and says how to set one", async () => {
  const got = await http("GET", "/projects/shop/jira");
  expect(ProjectJiraView.parse(got.json)).toEqual({
    source: null,
    last_sync: null,
  });
  const res = await sync("shop");
  expect(res.status).toBe(409);
  expect(errorOf(res.json)).toMatchObject({
    class: "conflict",
    message: expect.stringContaining("project shop has no Jira source"),
  });
  const statuses = await http("GET", "/projects/shop/jira/statuses");
  expect(statuses.status).toBe(409);
});

const BAD_SITES = [
  "https://jira.example.test",
  "http://acme.atlassian.net",
  "https://acme.atlassian.net/jira",
  "https://evil.atlassian.net.attacker.com",
];

test.each(BAD_SITES)(
  "a site that is not Atlassian's is 400 on create and on PATCH, writing nothing: %s",
  async (url) => {
    const created = await http("POST", "/projects", {
      name: "e2e-bad-site",
      repo_url: "https://example.com/e2e.git",
      runner_id: "fixture",
      jira: { ...SOURCE, url },
    });
    expect(created.status).toBe(400);
    const patched = await http("PATCH", "/projects/blog", {
      jira: { ...SOURCE, url },
    });
    expect(patched.status).toBe(400);
    const listed = ProjectsView.parse((await http("GET", "/projects")).json);
    expect(listed.projects.map((p) => [p.id, p.jira])).toEqual([
      ["blog", null],
      ["shop", null],
    ]);
  },
);

test("POST /projects takes a source, normalised; its audit row names it, with no secret", async () => {
  const res = await http("POST", "/projects", {
    name: "e2e-jira",
    repo_url: "https://example.com/e2e-jira.git",
    runner_id: "fixture",
    jira: { url: "https://Acme.Atlassian.net/", email: EMAIL, jql: ` ${JQL} ` },
  });
  expect(res.status).toBe(201);
  const listed = ProjectsView.parse((await http("GET", "/projects")).json);
  expect(listed.projects.find((p) => p.id === "e2e-jira")?.jira).toEqual(
    SOURCE,
  );
  const audit = AuditPage.parse(
    (await http("GET", "/audit?action=project.create")).json,
  ).items;
  expect(audit[0]?.payload).toMatchObject({ jira: SOURCE });
});

test("PATCH sets the source (one project.set row), then GET /projects/:id/jira shows it", async () => {
  const res = await http("PATCH", "/projects/blog", { jira: SOURCE });
  expect(res.status).toBe(200);
  expect(ProjectSettingsState.parse(res.json)).toEqual({
    project: "blog",
    staff_approval: false,
    jira: SOURCE,
    qa: NO_QA,
    docs: NO_DOCS,
    delivery: NO_DELIVERY,
    jira_push: DEFAULT_JIRA_PUSH_VIEW,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
    push_targets: [],
    qa_ticket: null,
    changed: true,
  });
  const again = await http("PATCH", "/projects/blog", { jira: SOURCE });
  expect(ProjectSettingsState.parse(again.json).changed).toBe(false);
  const audit = AuditPage.parse(
    (await http("GET", "/audit?action=project.set")).json,
  ).items;
  expect(audit.map((a) => [a.target_id, a.payload])).toEqual([
    ["blog", { jira: SOURCE }],
  ]);
  expect(
    ProjectJiraView.parse((await http("GET", "/projects/blog/jira")).json),
  ).toEqual({ source: SOURCE, last_sync: null });
});

test("PATCH jira_push sets the status map and the comment switch, audited; a bad map is 400", async () => {
  const push = {
    status_map: { started: "In Progress", done: "Done" },
    comment_prs: false,
  };
  const res = await http("PATCH", "/projects/blog", { jira_push: push });
  expect(res.status).toBe(200);
  expect(ProjectSettingsState.parse(res.json)).toMatchObject({
    jira_push: push,
    changed: true,
  });
  const listed = ProjectsView.parse((await http("GET", "/projects")).json);
  expect(listed.projects.find((p) => p.id === "blog")?.jira_push).toEqual(push);
  const audit = AuditPage.parse(
    (await http("GET", "/audit?action=project.set")).json,
  ).items;
  expect(audit[0]?.payload).toEqual({ jira_push: push });
  for (const bad of [
    { status_map: { started: "" }, comment_prs: true },
    { status_map: { later: "Done" }, comment_prs: true },
    { status_map: { done: "x".repeat(101) }, comment_prs: true },
    { status_map: {} },
  ]) {
    const refused = await http("PATCH", "/projects/blog", { jira_push: bad });
    expect(refused.status, JSON.stringify(bad)).toBe(400);
  }
  const back = await http("PATCH", "/projects/blog", {
    jira_push: { status_map: {}, comment_prs: true },
  });
  expect(ProjectSettingsState.parse(back.json).jira_push).toEqual({
    status_map: {},
    comment_prs: true,
  });
});

test("a first sync files the To Do issues as backlog tickets and ignores the rest", async () => {
  put(
    issue(1, { type: "Bug", priority: "High" }),
    issue(2),
    issue(3, { status: "In Progress", category: "indeterminate" }),
    issue(4),
    issue(5, { parent: { key: "ACME-100", summary: "Checkout" } }),
  );
  fx.queries.set(JQL, ["20001", "20002", "20003", "20004", "20005"]);
  fx.pageSize = 2;
  const res = await sync("blog");
  expect(res.status).toBe(200);
  expect(JiraSyncResult.parse(res.json)).toEqual({
    project: "blog",
    matched: 5,
    created: 4,
    updated: 0,
    unchanged: 0,
    parked: 0,
    ignored: 1,
    skipped: [],
    capped: false,
  });
  expect(await ticketOf(1)).toMatchObject({
    title: "Issue 1",
    type: "bug",
    priority: 2,
    status: "backlog",
    origin: "jira",
    origin_ref: "ACME-1",
    workspace_id: "blog",
  });
  expect((await ticketOf(5))?.body_md).toBe(
    "Jira: [ACME-5](https://acme.atlassian.net/browse/ACME-5) · Parent: ACME-100 Checkout",
  );
  expect(await ticketOf(3)).toBeNull();
  expect(
    fx.requests.every((r) => r.authorization === `Basic ${BASIC_B64}`),
  ).toBe(true);
});

test("a replay changes nothing: every version and event as it was", async () => {
  const before = unwrap(await dumpAllRows(apiDb));
  const res = await sync("blog");
  expect(JiraSyncResult.parse(res.json)).toMatchObject({
    created: 0,
    updated: 0,
    unchanged: 4,
    parked: 0,
  });
  const after = unwrap(await dumpAllRows(apiDb));
  expect(after.tickets).toEqual(before.tickets);
  expect(after.ticket_events).toEqual(before.ticket_events);
});

test("departures park the unstarted tickets with why, a rename updates one, a new issue is filed", async () => {
  // 1 moved on in Jira (still in the result), 2 gone from sight, 4 outside a query that changed,
  // 5 renamed, 6 new.
  put(
    issue(1, { status: "In Progress", category: "indeterminate" }),
    issue(5, {
      summary: "Issue 5, renamed",
      parent: { key: "ACME-100", summary: "Checkout" },
    }),
    issue(6),
  );
  fx.issues.delete("20002");
  fx.queries.set(JQL, ["20001", "20003", "20005", "20006"]);
  const res = await sync("blog");
  expect(res.status).toBe(200);
  expect(JiraSyncResult.parse(res.json)).toEqual({
    project: "blog",
    matched: 4,
    created: 1,
    updated: 1,
    unchanged: 0,
    parked: 3,
    ignored: 2,
    skipped: [],
    capped: false,
  });
  const statuses = await Promise.all([1, 2, 4, 5, 6].map(ticketOf));
  expect(statuses.map((t) => [t?.origin_ref, t?.status, t?.version])).toEqual([
    ["ACME-1", "parked", 2],
    ["ACME-2", "parked", 2],
    ["ACME-4", "parked", 2],
    ["ACME-5", "backlog", 2],
    ["ACME-6", "backlog", 1],
  ]);
  const byTicket = new Map(statuses.map((t) => [t?.id, t?.origin_ref]));
  const parks = TicketEvents.parse(
    unwrap(await dumpAllRows(apiDb)).ticket_events,
  )
    .filter((e) => e.kind === "transition" && e.to_status === "parked")
    .map((e) => [byTicket.get(e.ticket_id), e.reason])
    .toSorted();
  expect(parks).toEqual([
    ["ACME-1", "moved to In Progress in Jira"],
    ["ACME-2", "no longer visible in Jira"],
    ["ACME-4", "no longer matches the project's Jira query"],
  ]);

  // Converged: the next run writes nothing, and the parked stay parked.
  const again = await sync("blog");
  expect(JiraSyncResult.parse(again.json)).toMatchObject({
    created: 0,
    updated: 0,
    parked: 0,
  });
});

test("each run is one jira.sync row in the project's timeline, and GET shows the last", async () => {
  const timeline = TimelinePage.parse(
    (await http("GET", "/projects/blog/timeline?kind=audit.jira.sync")).json,
  );
  expect(timeline.items).toHaveLength(4);
  expect(timeline.items[0]).toMatchObject({
    kind: "audit.jira.sync",
    actor: "operator",
    payload: { via: "rest", ok: true, created: 0, parked: 0 },
  });
  const view = ProjectJiraView.parse(
    (await http("GET", "/projects/blog/jira")).json,
  );
  expect(view.source).toEqual(SOURCE);
  expect(view.last_sync).toMatchObject({
    via: "rest",
    ok: true,
    created: 0,
    updated: 0,
    parked: 0,
    skipped: [],
    capped: false,
  });
  expect(view.last_sync?.at).toBe(timeline.items[0]?.ts);
  expect(view.last_sync).not.toHaveProperty("error");
});

test("a second sync while one runs is 409; the first then finishes", async () => {
  let entered = (): void => undefined;
  const inFlight = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = (): void => undefined;
  hold = {
    entered: () => entered(),
    release: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const first = sync("blog");
  await inFlight;
  const second = await sync("blog");
  expect(second.status).toBe(409);
  expect(errorOf(second.json)).toMatchObject({
    class: "conflict",
    retryable: true,
    message: "a Jira sync of project blog is already running",
  });
  release();
  expect((await first).status).toBe(200);
});

test("a login Jira rejects: 400 saying so, one jira.sync row with ok false and the message, no ticket filed", async () => {
  // A new To Do issue the query matches: a search that ran would file it.
  const query = fx.queries.get(JQL) ?? [];
  put(issue(7));
  fx.queries.set(JQL, [...query, "20007"]);
  const rowsBefore = (await syncRows("blog")).length;
  fx.loginOverrides.push({
    status: 401,
    body: `{"errorMessages":["Client must be authenticated to access this resource."],"echo":"${TOKEN}"}`,
  });
  try {
    const res = await sync("blog");
    expect(res.status).toBe(400);
    const message =
      'Jira didn\'t accept the API token for op@acme.test on acme.atlassian.net. The token must come from that same Atlassian account (id.atlassian.com → Security → API tokens). A token stored through the `security` prompt is cut to 128 characters; store it with `-w "$(pbpaste)"` instead.';
    expect(errorOf(res.json)).toEqual({
      class: "validation",
      message,
      retryable: false,
    });
    const rows = await syncRows("blog");
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows[0]).toMatchObject({
      via: "rest",
      ok: false,
      matched: 0,
      created: 0,
      error: { class: "validation", message, retryable: false },
    });
    expect(await ticketOf(7)).toBeNull();
    expect(fx.requests.at(-1)?.path).toBe(LOGIN_PATH);
  } finally {
    fx.queries.set(JQL, query);
    fx.issues.delete("20007");
  }
});

test("a token Jira refuses on the search: 400 naming JIRA_API_TOKEN, audited as failed, logged without the token", async () => {
  fx.overrides.push({ status: 401, body: `{"echo":"${TOKEN}"}` });
  const res = await sync("blog");
  expect(res.status).toBe(400);
  expect(errorOf(res.json)).toMatchObject({
    class: "validation",
    message: expect.stringContaining(
      "Jira refused the token for acme.atlassian.net: check JIRA_API_TOKEN",
    ),
  });
  const view = ProjectJiraView.parse(
    (await http("GET", "/projects/blog/jira")).json,
  );
  expect(view.last_sync).toMatchObject({
    ok: false,
    created: 0,
    error: { class: "validation", retryable: false },
  });
  expect(lines.some((l) => l.includes("jira sync of blog (rest) failed"))).toBe(
    true,
  );
});

test("Jira failing is 502, retryable", async () => {
  fx.overrides.push({ status: 503, body: "" });
  const down = await sync("blog");
  expect(down.status).toBe(502);
  expect(errorOf(down.json)).toMatchObject({
    class: "runner_error",
    retryable: true,
  });
});

test("a sync that throws is a typed 500, not an unhandled one: its jira.sync row says so, scrubbed, and the next sync runs", async () => {
  poisoned = true;
  const res = await sync("blog").finally(() => {
    poisoned = false;
  });
  expect(res.status).toBe(500);
  expect(errorOf(res.json)).toEqual({
    class: "internal",
    message:
      "Something went wrong on the server: try again, and if it keeps failing, check the API's log.",
    retryable: false,
  });
  const view = ProjectJiraView.parse(
    (await http("GET", "/projects/blog/jira")).json,
  );
  expect(view.last_sync).toMatchObject({
    via: "rest",
    ok: false,
    error: {
      class: "internal",
      message:
        "the Jira sync of blog failed unexpectedly: poisoned issue ACME-1 <redacted>",
      retryable: false,
    },
  });
  // The lock was let go: the next sync runs, and finds nothing to do.
  const next = await sync("blog");
  expect(next.status).toBe(200);
  expect(JiraSyncResult.parse(next.json)).toMatchObject({ created: 0 });
});

test.each<[SecretStoreKind, readonly string[]]>([
  [
    "keychain",
    [
      '`security add-generic-password -U -s foreman-0123456789ab -a JIRA_API_TOKEN -w "$(pbpaste)"`',
      "`security find-generic-password -s foreman-0123456789ab -a JIRA_API_TOKEN -w | wc -c` prints about 190",
      "or set FRM_SECRET_JIRA_API_TOKEN in the API's environment",
    ],
  ],
  [
    "file",
    [
      "`sudo /srv/bayon/<deployment>/secrets.sh put <deployment> api JIRA_API_TOKEN` (the value on stdin)",
    ],
  ],
])(
  "a missing token under the %s store is 400 naming how that store takes it, and that no restart is needed",
  async (store, says) => {
    kind = store;
    tokenStored = false;
    try {
      const missing = await sync("blog");
      expect(missing.status).toBe(400);
      const message = errorOf(missing.json).message;
      for (const part of says) expect(message).toContain(part);
      expect(message).toContain("the next sync reads it, no restart needed");
      expect(message).not.toContain(
        store === "file" ? "security add-generic-password" : "secrets.sh",
      );
    } finally {
      kind = "keychain";
      tokenStored = true;
    }
  },
);

test.each<[SecretStoreKind, boolean]>([
  ["keychain", true],
  ["keychain", false],
  ["file", true],
  ["file", false],
])(
  "GET /jira under the %s store, token stored %s: a boolean, never the value",
  async (store, stored) => {
    kind = store;
    tokenStored = stored;
    try {
      const res = await http("GET", "/jira");
      expect(res.status).toBe(200);
      expect(JiraTokenStatus.parse(res.json)).toEqual({
        secret: "JIRA_API_TOKEN",
        store,
        keychain: store === "file" ? null : SCRATCH_KEYCHAIN,
        present: stored,
      });
      expect(JSON.stringify(res.json)).not.toContain(TOKEN);
    } finally {
      kind = "keychain";
      tokenStored = true;
    }
  },
);

test("GET /jira needs the operator's bearer", async () => {
  expect((await fetch(`${api.url}/jira`)).status).toBe(401);
});

test("PATCH jira: null turns the mirror off; its tickets stay", async () => {
  const res = await http("PATCH", "/projects/blog", { jira: null });
  expect(ProjectSettingsState.parse(res.json)).toMatchObject({
    jira: null,
    changed: true,
  });
  expect((await sync("blog")).status).toBe(409);
  expect(
    ProjectJiraView.parse((await http("GET", "/projects/blog/jira")).json)
      .source,
  ).toBeNull();
  expect((await ticketOf(6))?.status).toBe("backlog");
});

test("the token is in no row of any table, no response body and no log line", async () => {
  // It was sent: every request carried it, in the header and nowhere else.
  expect(fx.requests.length).toBeGreaterThan(0);
  for (const r of fx.requests) {
    expect(r.authorization).toBe(`Basic ${BASIC_B64}`);
    expect(r.query.toString()).not.toContain(TOKEN);
  }
  const everything = JSON.stringify(unwrap(await dumpAllRows(apiDb)));
  const logged = lines.join("\n");
  for (const secret of [TOKEN, BASIC_B64]) {
    expect(everything).not.toContain(secret);
    expect(logged).not.toContain(secret);
    for (const body of bodies) expect(body).not.toContain(secret);
  }
  expect(bodies.length).toBeGreaterThan(20);
});
