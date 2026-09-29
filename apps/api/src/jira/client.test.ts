// The Jira client against a local fixture server, never a real Jira: pages on
// nextPageToken, stops at the cap, maps each refusal to a typed error that names neither the token
// nor its header, refuses a redirect, times out, and zod-refuses a body it cannot read. And the
// login: `/myself` first, and any answer Jira served anonymously refused.
import { JIRA_FIELDS, type JiraIssue } from "@bayon/core";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  getByIds,
  searchJql,
  type JiraAuth,
  type SearchOptions,
} from "./client.js";
import {
  FIXTURE_SITE,
  LOGIN_PATH,
  SEARCH_PATH,
  startJiraFixture,
  type FixtureIssue,
  type JiraFixture,
} from "./fixtures.js";

const TOKEN = "fake-jira-token-4f1c9e2a7b";
const AUTH: JiraAuth = { email: "op@acme.test", token: TOKEN };
const BASIC = `Basic ${Buffer.from(`op@acme.test:${TOKEN}`).toString("base64")}`;
const JQL = "project = ACME";

let fx: JiraFixture;
beforeAll(async () => {
  fx = await startJiraFixture();
});
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  fx.requests.length = 0;
  fx.overrides.length = 0;
  fx.loginOverrides.length = 0;
  fx.issues.clear();
  fx.queries.clear();
  fx.refusedIds.clear();
  fx.pageSize = 100;
});

const issue = (n: number, o: Partial<FixtureIssue> = {}): FixtureIssue => ({
  id: String(10_000 + n),
  key: `ACME-${n}`,
  summary: `Issue ${n}`,
  ...o,
});

/** The search requests the fixture saw, `/myself` left out. */
const searches = () => fx.requests.filter((r) => r.path === SEARCH_PATH);

function seed(count: number, jql = JQL): void {
  const ids = Array.from({ length: count }, (_, i) => {
    const it = issue(i + 1);
    fx.issues.set(it.id, it);
    return it.id;
  });
  fx.queries.set(jql, ids);
}

async function search(
  o: Partial<SearchOptions> = {},
  site = FIXTURE_SITE,
): Promise<{
  readonly result: Awaited<ReturnType<typeof searchJql>>;
  readonly pages: (readonly JiraIssue[])[];
}> {
  const pages: (readonly JiraIssue[])[] = [];
  const result = await searchJql(site, AUTH, JQL, JIRA_FIELDS, {
    fetch: fx.fetchVia(),
    timeoutMs: 5_000,
    onPage: async (issues) => {
      pages.push(issues);
      return { ok: true, value: undefined };
    },
    ...o,
  });
  return { result, pages };
}

/** No message says the token, the header, or its base64. */
function expectNoSecret(message: string): void {
  expect(message).not.toContain(TOKEN);
  expect(message).not.toContain("Basic");
  expect(message).not.toContain(BASIC.slice("Basic ".length));
}

test("two pages: each handed over in order, the second asked for by its token, with the auth header and Accept", async () => {
  seed(3);
  fx.pageSize = 2;
  const { result, pages } = await search();
  expect(result).toEqual({ ok: true, value: { fetched: 3, capped: false } });
  expect(pages.map((p) => p.map((i) => i.key))).toEqual([
    ["ACME-1", "ACME-2"],
    ["ACME-3"],
  ]);
  expect(fx.requests.map((r) => r.path)).toEqual([
    LOGIN_PATH,
    SEARCH_PATH,
    SEARCH_PATH,
  ]);
  const [first, second] = searches();
  expect(first?.query.get("jql")).toBe(JQL);
  expect(first?.query.get("fields")).toBe(
    "summary,description,issuetype,priority,parent,status",
  );
  expect(first?.query.get("maxResults")).toBe("100");
  expect(first?.query.has("nextPageToken")).toBe(false);
  expect(second?.query.get("nextPageToken")).toBe("2");
  for (const r of fx.requests) {
    expect(r.authorization).toBe(BASIC);
    expect(r.accept).toBe("application/json");
  }
});

test("the cap: past maxIssues the search stops and says capped; exactly at it with the last page it does not", async () => {
  seed(5);
  fx.pageSize = 2;
  const capped = await search({ maxIssues: 3 });
  expect(capped.result).toEqual({
    ok: true,
    value: { fetched: 3, capped: true },
  });
  expect(capped.pages.flat().map((i) => i.key)).toEqual([
    "ACME-1",
    "ACME-2",
    "ACME-3",
  ]);

  fx.requests.length = 0;
  const atCap = await search({ maxIssues: 4 });
  expect(atCap.result).toEqual({
    ok: true,
    value: { fetched: 4, capped: true },
  });
  expect(searches()).toHaveLength(2);

  seed(4);
  const whole = await search({ maxIssues: 4 });
  expect(whole.result).toEqual({
    ok: true,
    value: { fetched: 4, capped: false },
  });
});

test("the default cap is 1000 issues", async () => {
  seed(1_005);
  const { result } = await search();
  expect(result).toEqual({ ok: true, value: { fetched: 1_000, capped: true } });
  expect(searches()).toHaveLength(10);
});

test("an empty page ends the search, whatever token it carries", async () => {
  fx.overrides.push({
    status: 200,
    body: JSON.stringify({ issues: [], nextPageToken: "again", isLast: false }),
  });
  const { result } = await search();
  expect(result).toEqual({ ok: true, value: { fetched: 0, capped: false } });
  expect(searches()).toHaveLength(1);
});

test.each([401, 403])(
  "%d: Jira refused the token, said without the token or Basic",
  async (status) => {
    fx.overrides.push({ status, body: `{"message":"${TOKEN}"}` });
    const { result } = await search();
    expect(result).toMatchObject({
      ok: false,
      error: { class: "validation", retryable: false },
    });
    if (result.ok) return;
    expect(result.error.message).toContain(
      "Jira refused the token for acme.atlassian.net: check JIRA_API_TOKEN",
    );
    expect(result.error.message).toContain(`HTTP ${status}`);
    expectNoSecret(result.error.message);
  },
);

/** What a rejected email and token pair says, wherever Jira rejects it. */
const LOGIN_REJECTED =
  'Jira didn\'t accept the API token for op@acme.test on acme.atlassian.net. The token must come from that same Atlassian account (id.atlassian.com → Security → API tokens). A token stored through the `security` prompt is cut to 128 characters; store it with `-w "$(pbpaste)"` instead.';
const ANONYMOUS = { "x-seraph-loginreason": "AUTHENTICATED_FAILED" };

test.each([401, 403])(
  "/myself %d: the login is rejected, a typed error without the token or Basic, and no search is sent",
  async (status) => {
    seed(2);
    fx.loginOverrides.push({
      status,
      body: JSON.stringify({
        errorMessages: [
          "Client must be authenticated to access this resource.",
        ],
        echo: TOKEN,
      }),
    });
    const { result, pages } = await search();
    expect(result).toEqual({
      ok: false,
      error: {
        class: "validation",
        message: LOGIN_REJECTED,
        retryable: false,
        cause: { http_status: status },
      },
    });
    if (!result.ok) expectNoSecret(result.error.message);
    expect(fx.requests.map((r) => r.path)).toEqual([LOGIN_PATH]);
    expect(pages).toEqual([]);
  },
);

test("/myself 200: the search proceeds, the login asked first with the same header", async () => {
  seed(2);
  // Read loosely: an account id is enough, no display name needed, other keys ignored.
  fx.loginOverrides.push({
    status: 200,
    body: JSON.stringify({ accountId: "5b10ac8d", timeZone: "UTC" }),
  });
  const { result, pages } = await search();
  expect(result).toEqual({ ok: true, value: { fetched: 2, capped: false } });
  expect(pages.flat().map((i) => i.key)).toEqual(["ACME-1", "ACME-2"]);
  const [login, first] = fx.requests;
  expect(login?.path).toBe(LOGIN_PATH);
  expect(login?.authorization).toBe(BASIC);
  expect(login?.accept).toBe("application/json");
  expect(first?.path).toBe(SEARCH_PATH);
});

test.each<
  [
    string,
    Parameters<JiraFixture["loginOverrides"]["push"]>[0],
    string,
    boolean,
  ]
>([
  [
    "a 200 with no account id",
    { status: 200, body: '{"displayName":"x"}' },
    "runner_error",
    false,
  ],
  [
    "a 200 that is not JSON",
    { status: 200, body: "<html>" },
    "runner_error",
    false,
  ],
  ["a 503", { status: 503, body: "" }, "runner_error", true],
  ["a redirect", { redirect: LOGIN_PATH }, "runner_error", false],
])(
  "/myself answering %s fails the search before it is sent",
  async (_name, answer, errorClass, retryable) => {
    seed(1);
    fx.loginOverrides.push(answer);
    const { result, pages } = await search();
    expect(result).toMatchObject({
      ok: false,
      error: { class: errorClass, retryable },
    });
    if (!result.ok) expectNoSecret(result.error.message);
    expect(searches()).toEqual([]);
    expect(pages).toEqual([]);
  },
);

test("a search Jira served anonymously (X-Seraph-LoginReason: AUTHENTICATED_FAILED) is the login rejected, not an empty result", async () => {
  fx.overrides.push({
    status: 200,
    body: JSON.stringify({ issues: [], isLast: true }),
    headers: ANONYMOUS,
  });
  const { result, pages } = await search();
  expect(result).toEqual({
    ok: false,
    error: { class: "validation", message: LOGIN_REJECTED, retryable: false },
  });
  expect(pages).toEqual([]);
});

test("/myself marked as served anonymously is the login rejected, even as a 200", async () => {
  fx.loginOverrides.push({
    status: 200,
    body: JSON.stringify({ accountId: "x" }),
    headers: { "X-Seraph-LoginReason": "AUTHENTICATED_FAILED" },
  });
  const { result } = await search();
  expect(result).toMatchObject({
    ok: false,
    error: { class: "validation", message: LOGIN_REJECTED },
  });
  expect(searches()).toEqual([]);
});

test("400: Jira's own messages explain a bad JQL, capped, and scrubbed of the token", async () => {
  fx.overrides.push({
    status: 400,
    body: JSON.stringify({
      errorMessages: [
        "Error in the JQL Query: Expecting operator but got 'banana'.",
        `echoed ${TOKEN}`,
      ],
      errors: { jql: "x".repeat(1_000) },
    }),
  });
  const { result } = await search();
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
  if (result.ok) return;
  expect(result.error.message).toMatch(
    /^Jira refused the query for acme\.atlassian\.net: Error in the JQL Query: Expecting operator but got 'banana'\.; echoed <redacted>; x+…$/,
  );
  expect(result.error.message.length).toBeLessThanOrEqual(500);
  expectNoSecret(result.error.message);
});

test("400 with a body that says nothing: the status", async () => {
  fx.overrides.push({ status: 400, body: "<html>" });
  const { result } = await search();
  expect(result).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: "Jira refused the query for acme.atlassian.net: HTTP 400",
    },
  });
});

test.each([
  [429, "runner_error", true],
  [500, "runner_error", true],
  [503, "runner_error", true],
  [404, "validation", false],
  [204, "runner_error", false],
])("HTTP %d is %s, retryable %s", async (status, errorClass, retryable) => {
  fx.overrides.push({ status, body: "" });
  const { result } = await search();
  expect(result).toMatchObject({
    ok: false,
    error: { class: errorClass, retryable },
  });
});

test("a redirect is refused, never followed: the header cannot travel with it", async () => {
  seed(1);
  fx.overrides.push({
    redirect: `/rest/api/3/search/jql?jql=${encodeURIComponent(JQL)}&fields=summary`,
  });
  const { result, pages } = await search();
  expect(result).toMatchObject({
    ok: false,
    error: { class: "runner_error", retryable: false },
  });
  if (!result.ok) {
    expect(result.error.message).toContain("redirect");
    expectNoSecret(result.error.message);
  }
  expect(searches()).toHaveLength(1);
  expect(pages).toEqual([]);
});

test("a Jira that never answers times out, retryable", async () => {
  fx.overrides.push({ hang: true });
  const { result } = await search({ timeoutMs: 50 });
  expect(result).toEqual({
    ok: false,
    error: {
      class: "timeout",
      message: "Jira at acme.atlassian.net did not answer within 50 ms",
      retryable: true,
    },
  });
});

test("the API stopping interrupts a request in flight", async () => {
  const stop = new AbortController();
  const { result } = await search({
    signal: stop.signal,
    // A request that only ends when its signal does; stopped as soon as it is sent.
    fetch: (_url, init) => {
      const pending = new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          {
            once: true,
          },
        );
      });
      stop.abort();
      return pending;
    },
  });
  expect(result).toMatchObject({
    ok: false,
    error: { class: "interrupted", retryable: true },
  });
});

test("an unreachable Jira is a retryable network error naming its code", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      code: "ECONNREFUSED",
    }),
  });
  const { result } = await search({ fetch: () => Promise.reject(refused) });
  expect(result).toEqual({
    ok: false,
    error: {
      class: "runner_error",
      message: "Jira at acme.atlassian.net could not be reached (ECONNREFUSED)",
      retryable: true,
    },
  });
  const odd = await search({ fetch: () => Promise.reject("nope") });
  expect(odd.result).toMatchObject({
    ok: false,
    error: {
      message:
        "Jira at acme.atlassian.net could not be reached (a network error)",
    },
  });
});

test.each([
  ["an issue that is no issue", { issues: [{ id: "x", key: "ACME-1" }] }],
  ["no issues list", { values: [] }],
  ["a status missing", { issues: [{ id: "1", key: "ACME-1", fields: {} }] }],
])("a body it cannot read is refused (zod): %s", async (_name, body) => {
  fx.overrides.push({ status: 200, body: JSON.stringify(body) });
  const { result, pages } = await search();
  expect(result).toMatchObject({
    ok: false,
    error: { class: "runner_error", retryable: false },
  });
  if (!result.ok) {
    expect(result.error.message).toContain(
      "Jira at acme.atlassian.net answered a search this cannot read",
    );
  }
  expect(pages).toEqual([]);
});

test("a 200 that is not JSON is refused", async () => {
  fx.overrides.push({ status: 200, body: "<html>maintenance</html>" });
  const { result } = await search();
  expect(result).toMatchObject({
    ok: false,
    error: {
      class: "runner_error",
      message:
        "Jira at acme.atlassian.net answered with a body that is not JSON",
    },
  });
});

test.each([
  "https://evil.test",
  "http://acme.atlassian.net",
  "https://evil.atlassian.net.attacker.com",
  "https://acme.atlassian.net/other",
])(
  "a site that is not Atlassian's is refused before any request: %s",
  async (site) => {
    const { result } = await search({}, site);
    expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(fx.requests).toEqual([]);
  },
);

test("a page the caller cannot take stops the search there", async () => {
  seed(3);
  fx.pageSize = 1;
  const { result } = await search({
    onPage: async () => ({
      ok: false,
      error: { class: "db_busy", message: "busy", retryable: true },
    }),
  });
  expect(result).toMatchObject({ ok: false, error: { class: "db_busy" } });
  expect(searches()).toHaveLength(1);
});

const byIds = (ids: readonly string[]) =>
  getByIds(FIXTURE_SITE, AUTH, ids, JIRA_FIELDS, {
    fetch: fx.fetchVia(),
    timeoutMs: 5_000,
  });

test("getByIds: 100 ids a search, as `id in (…)`; an id Jira no longer shows is absent", async () => {
  seed(150);
  const wanted = [...fx.issues.keys(), "99999"];
  const found = await byIds(wanted);
  expect(found.ok && found.value.map((i) => i.id)).toEqual([
    ...fx.issues.keys(),
  ]);
  expect(fx.requests.map((r) => r.query.get("jql")?.split(",").length)).toEqual(
    [100, 51],
  );
  expect(fx.requests[0]?.query.get("jql")).toMatch(/^id in \(10001,10002,/);
});

test("getByIds: a batch Jira refuses for an issue it cannot show is split until the rest are found", async () => {
  seed(4);
  fx.refusedIds.add("10003");
  const found = await byIds(["10001", "10002", "10003", "10004"]);
  expect(found.ok && found.value.map((i) => i.id).toSorted()).toEqual([
    "10001",
    "10002",
    "10004",
  ]);
});

test("getByIds: nothing asked is nothing fetched; an id that is no id is refused; another failure stops it", async () => {
  expect(await byIds([])).toEqual({ ok: true, value: [] });
  expect(fx.requests).toEqual([]);
  expect(await byIds(["10001) OR (project = X"])).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(fx.requests).toEqual([]);
  fx.overrides.push({ status: 503, body: "" });
  expect(await byIds(["10001"])).toMatchObject({
    ok: false,
    error: { class: "runner_error" },
  });
  seed(3);
  fx.refusedIds.add("10001");
  fx.overrides.push({ status: 400, body: "" }, { status: 400, body: "" });
  fx.overrides.push({ status: 500, body: "" });
  expect(await byIds(["10001", "10002", "10003"])).toMatchObject({
    ok: false,
    error: { class: "runner_error" },
  });
});

test("getByIds: an answer served anonymously is the login rejected, never split or read as gone", async () => {
  seed(2);
  fx.overrides.push({ status: 400, body: "", headers: ANONYMOUS });
  expect(await byIds(["10001", "10002"])).toEqual({
    ok: false,
    error: { class: "validation", message: LOGIN_REJECTED, retryable: false },
  });
  expect(fx.requests).toHaveLength(1);
  fx.overrides.push({
    status: 200,
    body: JSON.stringify({ issues: [], isLast: true }),
    headers: ANONYMOUS,
  });
  expect(await byIds(["10001"])).toMatchObject({
    ok: false,
    error: { message: LOGIN_REJECTED },
  });
  // It asks no /myself of its own: the search before it did.
  expect(fx.requests.map((r) => r.path)).toEqual([SEARCH_PATH, SEARCH_PATH]);
});

test("a body whose Content-Length is past the cap is refused before it is read, without the token", async () => {
  const body = JSON.stringify({ issues: [], note: "x".repeat(5_000) });
  fx.overrides.push({
    status: 200,
    body,
    headers: { "content-length": String(Buffer.byteLength(body)) },
  });
  const { result, pages } = await search({ maxBodyBytes: 1_024 });
  expect(result).toEqual({
    ok: false,
    error: {
      class: "runner_error",
      message:
        "Jira at acme.atlassian.net answered with a body over 1024 bytes, which is refused",
      retryable: false,
    },
  });
  expect(pages).toEqual([]);
});

test("a streamed body with no Content-Length is cut off as it passes the cap", async () => {
  const chunk = "x".repeat(600);
  fx.overrides.push({
    status: 200,
    chunks: ['{"issues":[],"a":"', chunk, chunk, chunk, '"}'],
  });
  const { result } = await search({ maxBodyBytes: 1_024 });
  expect(result).toMatchObject({
    ok: false,
    error: { class: "runner_error", retryable: false },
  });
  if (!result.ok) {
    expect(result.error.message).toContain("over 1024 bytes");
    expectNoSecret(result.error.message);
  }
  // Under the cap the same streamed answer is read whole.
  fx.overrides.push({
    status: 200,
    chunks: ['{"issues":[],', '"isLast":true}'],
  });
  expect((await search({ maxBodyBytes: 1_024 })).result).toEqual({
    ok: true,
    value: { fetched: 0, capped: false },
  });
});
