import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  DOCS_MARKDOWN_MAX,
  docsPageId,
  getPage,
  searchPages,
  type DocsAuth,
} from "./client.js";
import {
  CONTENT_PATH,
  DOCS_LOGIN_PATH,
  FIXTURE_DOCS_SITE,
  SEARCH_PATH,
  startDocsFixture,
  type DocsFixture,
  type FixturePage,
} from "./fixtures.js";

// The documentation client against a local fixture server, never a real site: the CQL
// search, one page by id, the refusals each maps to, and the guards it shares with the Jira mirror —
// the site pin, the refused redirect, the body cap and the scrub.
//
// Every site, space and title here is a placeholder. Bayon knows nothing about any particular site.

const TOKEN = "fake-atlassian-token-91ab3c";
const AUTH: DocsAuth = { email: "op@acme.test", token: TOKEN };
const BASIC = `Basic ${Buffer.from(`op@acme.test:${TOKEN}`).toString("base64")}`;

let fx: DocsFixture;
beforeAll(async () => {
  fx = await startDocsFixture();
});
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  fx.requests.length = 0;
  fx.overrides.length = 0;
  fx.pageOverrides.length = 0;
  fx.loginOverrides.length = 0;
  fx.pages.clear();
  fx.queries.clear();
});

const DOC = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Done when" }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "the harness exits zero" }],
    },
  ],
};

const page = (o: Partial<FixturePage> = {}): FixturePage => {
  const p: FixturePage = {
    id: "101",
    title: "Acceptance",
    space: "ONE",
    adf: DOC,
    ...o,
  };
  fx.pages.set(p.id, p);
  return p;
};

const options = () => ({ fetch: fx.fetchVia(), timeoutMs: 5_000 });

const search = (
  o: Partial<Parameters<typeof searchPages>[2]> = {},
  site = FIXTURE_DOCS_SITE,
) =>
  searchPages(
    site,
    AUTH,
    { query: "done when", allowed: [], limit: 20, ...o },
    options(),
  );

const get = (ref: string, site = FIXTURE_DOCS_SITE) =>
  getPage(site, AUTH, ref, options());

/** No message says the token, the header, or its base64. */
function expectNoSecret(message: string): void {
  expect(message).not.toContain(TOKEN);
  expect(message).not.toContain("Basic");
  expect(message).not.toContain(BASIC.slice("Basic ".length));
}

test("a search asks who the auth logs in as first, then sends the CQL with the auth header", async () => {
  page();
  page({ id: "102", title: "Rules", space: "TWO" });
  const found = await search({ allowed: ["ONE", "TWO"] });
  expect(found).toMatchObject({ ok: true });
  if (!found.ok) return;
  expect(found.value).toEqual([
    {
      id: "101",
      title: "Acceptance",
      space: "ONE",
      url: `${FIXTURE_DOCS_SITE}/wiki/spaces/ONE/pages/101/Acceptance`,
      excerpt: "Acceptance …",
    },
    {
      id: "102",
      title: "Rules",
      space: "TWO",
      url: `${FIXTURE_DOCS_SITE}/wiki/spaces/TWO/pages/102/Rules`,
      excerpt: "Rules …",
    },
  ]);
  expect(fx.requests.map((r) => r.path)).toEqual([
    DOCS_LOGIN_PATH,
    SEARCH_PATH,
  ]);
  const sent = fx.requests[1];
  expect(sent?.query.get("cql")).toBe(
    'type = page AND text ~ "done when" AND space in ("ONE","TWO") order by lastmodified desc',
  );
  expect(sent?.query.get("limit")).toBe("20");
  for (const r of fx.requests) {
    expect(r.authorization).toBe(BASIC);
    expect(r.accept).toBe("application/json");
  }
});

test("the search is held to the project's spaces, and a query with CQL syntax stays one term", async () => {
  page();
  await search({
    query: '" OR type = user AND text ~ "',
    allowed: ["ONE"],
  });
  expect(fx.requests[1]?.query.get("cql")).toBe(
    'type = page AND text ~ "\\" OR type = user AND text \\~ \\"" AND space = "ONE" order by lastmodified desc',
  );
});

test("a page by id comes back as Markdown, its ADF parsed from the string the site sends", async () => {
  page();
  const got = await get("101");
  expect(got).toEqual({
    ok: true,
    value: {
      id: "101",
      title: "Acceptance",
      space: "ONE",
      url: `${FIXTURE_DOCS_SITE}/wiki/spaces/ONE/pages/101/Acceptance`,
      markdown: "## Done when\n\nthe harness exits zero",
    },
  });
  expect(fx.requests.map((r) => r.path)).toEqual([`${CONTENT_PATH}/101`]);
  expect(fx.requests[0]?.query.get("expand")).toBe(
    "space,body.atlas_doc_format,body.storage",
  );
});

test("a page with no ADF falls back to its storage text", async () => {
  page({ id: "103", adf: undefined, storage: "<p>plain <b>words</b></p>" });
  const got = await get("103");
  expect(got.ok && got.value.markdown).toBe("plain words");
});

test("a page longer than the cap is trimmed and says so", async () => {
  page({
    id: "104",
    adf: undefined,
    storage: "x".repeat(DOCS_MARKDOWN_MAX + 500),
  });
  const got = await get("104");
  expect(got.ok && got.value.markdown.length).toBeLessThan(
    DOCS_MARKDOWN_MAX + 100,
  );
  expect(got.ok && got.value.markdown).toContain("was not read");
});

test("a link on this site is a page reference; a link anywhere else is refused before any request", async () => {
  page();
  const byLink = await get(
    `${FIXTURE_DOCS_SITE}/wiki/spaces/ONE/pages/101/Acceptance`,
  );
  expect(byLink.ok && byLink.value.id).toBe("101");

  // The old-style link shape too.
  expect(
    docsPageId(
      `${FIXTURE_DOCS_SITE}/wiki/pages/viewpage.action?pageId=101`,
      FIXTURE_DOCS_SITE,
    ),
  ).toEqual({ ok: true, value: "101" });

  fx.requests.length = 0;
  for (const bad of [
    "https://evil.test/wiki/spaces/ONE/pages/101/x",
    "https://other.atlassian.net/wiki/spaces/ONE/pages/101/x",
    `${FIXTURE_DOCS_SITE}/wiki/spaces/ONE/overview`,
    "not a ref",
    "",
  ]) {
    const refusedRef = await get(bad);
    expect(refusedRef, bad).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  }
  expect(fx.requests).toEqual([]);
});

test("a page the site does not have is not_found, not a failure to answer", async () => {
  const missing = await get("999");
  expect(missing).toMatchObject({
    ok: false,
    error: { class: "not_found", retryable: false },
  });
  if (!missing.ok) expectNoSecret(missing.error.message);
});

test("401: the token is refused, said without the token or its header", async () => {
  fx.loginOverrides.push({ status: 401, body: `{"message":"${TOKEN}"}` });
  const found = await search();
  expect(found).toMatchObject({
    ok: false,
    error: { class: "validation", retryable: false },
  });
  if (found.ok) return;
  expect(found.error.message).toContain(
    "Confluence didn't accept the API token for op@acme.test on acme.atlassian.net",
  );
  expectNoSecret(found.error.message);

  // And a page read the site served anonymously is the same refusal, not an empty page.
  page();
  fx.pageOverrides.push({
    status: 200,
    body: JSON.stringify({ id: "101" }),
    headers: { "x-seraph-loginreason": "AUTHENTICATED_FAILED" },
  });
  const got = await get("101");
  expect(got).toMatchObject({ ok: false, error: { class: "validation" } });
  if (!got.ok) expectNoSecret(got.error.message);
});

test("a redirect is refused, never followed: the header cannot travel with it", async () => {
  page();
  fx.pageOverrides.push({ redirect: "https://evil.test/steal" });
  const got = await get("101");
  expect(got).toMatchObject({
    ok: false,
    error: { class: "runner_error", retryable: false },
  });
  if (!got.ok) {
    expect(got.error.message).toContain("redirect");
    expectNoSecret(got.error.message);
  }
  // One request: the redirect was not followed.
  expect(fx.requests).toHaveLength(1);
});

test("a body past the cap is refused, by its Content-Length and as a stream", async () => {
  const body = JSON.stringify({ results: [], note: "x".repeat(5_000) });
  fx.overrides.push({
    status: 200,
    body,
    headers: { "content-length": String(Buffer.byteLength(body)) },
  });
  const declared = await searchPages(
    FIXTURE_DOCS_SITE,
    AUTH,
    { query: "q", allowed: [], limit: 20 },
    { ...options(), maxBodyBytes: 1_024 },
  );
  expect(declared).toMatchObject({
    ok: false,
    error: { class: "runner_error", retryable: false },
  });
  if (!declared.ok) {
    expect(declared.error.message).toContain("over 1024 bytes");
    expectNoSecret(declared.error.message);
  }

  const chunk = "x".repeat(600);
  fx.overrides.push({
    status: 200,
    chunks: ['{"results":[],"a":"', chunk, chunk, chunk, '"}'],
  });
  const streamed = await searchPages(
    FIXTURE_DOCS_SITE,
    AUTH,
    { query: "q", allowed: [], limit: 20 },
    { ...options(), maxBodyBytes: 1_024 },
  );
  expect(streamed).toMatchObject({
    ok: false,
    error: { class: "runner_error" },
  });
});

test("a site that is not Atlassian's is refused before any request", async () => {
  for (const site of [
    "https://evil.test",
    "http://acme.atlassian.net",
    "https://acme.atlassian.net/wiki",
  ]) {
    expect(await search({}, site), site).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(await get("101", site), site).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  }
  expect(fx.requests).toEqual([]);
});

test("an answer it cannot read is refused rather than half-read", async () => {
  fx.overrides.push({ status: 200, body: JSON.stringify({ values: [] }) });
  expect(await search()).toMatchObject({
    ok: false,
    error: { class: "runner_error" },
  });
  page();
  fx.pageOverrides.push({ status: 200, body: JSON.stringify({ title: "x" }) });
  expect(await get("101")).toMatchObject({
    ok: false,
    error: { class: "runner_error" },
  });
  // A result row that is no page is skipped, not read as one.
  fx.overrides.push({
    status: 200,
    body: JSON.stringify({ results: [{ title: "a user", excerpt: "" }] }),
  });
  expect(await search()).toEqual({ ok: true, value: [] });
});

test("a site that never answers times out, retryable", async () => {
  fx.loginOverrides.push({ hang: true });
  const found = await searchPages(
    FIXTURE_DOCS_SITE,
    AUTH,
    { query: "q", allowed: [], limit: 20 },
    { fetch: fx.fetchVia(), timeoutMs: 50 },
  );
  expect(found).toEqual({
    ok: false,
    error: {
      class: "timeout",
      message: "Confluence at acme.atlassian.net did not answer within 50 ms",
      retryable: true,
    },
  });
});
