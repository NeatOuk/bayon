import { NO_DOCS_SOURCE, err, ok, type DocsSourceFields } from "@bayon/core";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { JiraTokenStore } from "../jira/token.js";
import { DocsReader, PAGE_UNAVAILABLE, isDocsRefused } from "./reader.js";
import {
  FIXTURE_DOCS_SITE,
  SEARCH_PATH,
  startDocsFixture,
  type DocsFixture,
  type FixturePage,
} from "./fixtures.js";

// What decides what an agent may read: the project's source, the host-store token, and
// the space allowlist. Against a local fixture server; no test reaches a real site, and no real
// secret is ever read.

const TOKEN = "fake-atlassian-token-91ab3c";

let fx: DocsFixture;
beforeAll(async () => {
  fx = await startDocsFixture();
});
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  fx.requests.length = 0;
  fx.pages.clear();
});

const store = (value = TOKEN): JiraTokenStore => ({
  kind: "keychain",
  keychain: { service: "foreman-0123456789ab", owner: false },
  secrets: { get: () => Promise.resolve(ok(value)) },
});

const missingToken: JiraTokenStore = {
  kind: "keychain",
  keychain: { service: "foreman-0123456789ab", owner: false },
  secrets: {
    get: (name) =>
      Promise.resolve(
        err({
          class: "validation",
          message: `secret ${name} is not in the secret store`,
          retryable: false,
        }),
      ),
  },
};

const reader = (token: JiraTokenStore = store()) =>
  new DocsReader({ token, fetch: fx.fetchVia(), timeoutMs: 5_000 });

const SOURCE: DocsSourceFields = {
  kind: "confluence",
  url: FIXTURE_DOCS_SITE,
  email: "op@acme.test",
  spaces: ["ONE"],
};

const page = (o: Partial<FixturePage> = {}): FixturePage => {
  const p: FixturePage = {
    id: "101",
    title: "Acceptance",
    space: "ONE",
    storage: "<p>the harness exits zero</p>",
    ...o,
  };
  fx.pages.set(p.id, p);
  return p;
};

test("a project with no documentation source is refused, not failed: nothing is broken", async () => {
  const r = reader();
  for (const source of [
    NO_DOCS_SOURCE,
    { ...SOURCE, kind: "none" as const },
    // A half-written source could only ever fail; 037's CHECK bars it, and this refuses it anyway.
    { ...SOURCE, url: null },
    { ...SOURCE, email: null },
  ]) {
    const found = await r.search(source, { query: "q", limit: 20 });
    expect(found.ok && isDocsRefused(found.value) && found.value).toMatchObject(
      { refused: "no_source" },
    );
    const got = await r.get(source, "101");
    expect(got.ok && isDocsRefused(got.value) && got.value).toMatchObject({
      refused: "no_source",
    });
  }
  // Refused before any request: no token is read and no site is reached.
  expect(fx.requests).toEqual([]);
});

// The one that matters most (security review): page ids are shared and roughly
// sequential across a site, so "outside your spaces" and "no such page" must be the same answer.
// Anything that told them apart would let an agent walk the id space with the operator's token and
// map the tenant's pages and space keys, and a hostile page could tell it to.
test("a page outside the project's spaces and a page that is not there are the same answer, naming no space", async () => {
  page({ id: "202", space: "TWO" });
  const outside = await reader().get(SOURCE, "202");
  const missing = await reader().get(SOURCE, "999");
  expect(outside).toEqual(missing);
  expect(outside.ok && isDocsRefused(outside.value) && outside.value).toEqual({
    refused: "unavailable",
    detail: PAGE_UNAVAILABLE,
  });
  // No space at all: not the page's, and not the granted list either.
  expect(PAGE_UNAVAILABLE).not.toContain("TWO");
  expect(PAGE_UNAVAILABLE).not.toContain("ONE");

  // A page in a granted space still reads fine.
  page({ id: "201", space: "ONE" });
  const allowed = await reader().get(SOURCE, "201");
  expect(
    allowed.ok && !isDocsRefused(allowed.value) && allowed.value,
  ).toMatchObject({ id: "201", space: "ONE" });
});

test("a page whose space the site did not say is the same refusal: not readable, nothing said", async () => {
  page({ id: "203", space: "" });
  const got = await reader().get(SOURCE, "203");
  expect(got.ok && isDocsRefused(got.value) && got.value).toEqual({
    refused: "unavailable",
    detail: PAGE_UNAVAILABLE,
  });
});

test("an empty space list means any space the account can read", async () => {
  page({ id: "204", space: "ANY" });
  const open = { ...SOURCE, spaces: [] };
  const got = await reader().get(open, "204");
  expect(got.ok && !isDocsRefused(got.value) && got.value).toMatchObject({
    id: "204",
  });
});

test("a search is constrained to the project's spaces, whatever space is asked for", async () => {
  page();
  const source = { ...SOURCE, spaces: ["ONE", "THREE"] };
  // A space outside the list is refused before any request.
  const outside = await reader().search(source, {
    query: "q",
    space: "TWO",
    limit: 20,
  });
  expect(
    outside.ok && isDocsRefused(outside.value) && outside.value,
  ).toMatchObject({ refused: "out_of_space" });
  expect(fx.requests).toEqual([]);

  // A space inside it narrows the query; the query itself always names the project's own list.
  await reader().search(source, { query: "q", space: "THREE", limit: 20 });
  const sent = fx.requests.filter((r) => r.path === SEARCH_PATH);
  expect(sent[0]?.query.get("cql")).toContain('space = "THREE"');

  fx.requests.length = 0;
  await reader().search(source, { query: "q", limit: 20 });
  expect(
    fx.requests.filter((r) => r.path === SEARCH_PATH)[0]?.query.get("cql"),
  ).toContain('space in ("ONE","THREE")');
});

test("a mixed-case space is read by its exact key: `Docs` is granted, `DOCS` is not", async () => {
  page({ id: "301", space: "Docs" });
  page({ id: "302", space: "DOCS" });
  const source = { ...SOURCE, spaces: ["Docs"] };

  const got = await reader().get(source, "301");
  expect(got.ok && !isDocsRefused(got.value) && got.value).toMatchObject({
    id: "301",
    space: "Docs",
  });
  const other = await reader().get(source, "302");
  expect(other.ok && isDocsRefused(other.value) && other.value).toEqual({
    refused: "unavailable",
    detail: PAGE_UNAVAILABLE,
  });

  // A search names the key as granted and finds only that space's pages.
  const found = await reader().search(source, { query: "q", limit: 20 });
  expect(
    fx.requests.filter((r) => r.path === SEARCH_PATH)[0]?.query.get("cql"),
  ).toContain('space = "Docs"');
  expect(
    found.ok && !isDocsRefused(found.value) && found.value.map((h) => h.id),
  ).toEqual(["301"]);

  const outside = await reader().search(source, {
    query: "q",
    space: "DOCS",
    limit: 20,
  });
  expect(
    outside.ok && isDocsRefused(outside.value) && outside.value,
  ).toMatchObject({ refused: "out_of_space" });
});

test("no token in the host store: a validation error saying how to store it, naming no value", async () => {
  page();
  const got = await reader(missingToken).get(SOURCE, "101");
  expect(got).toMatchObject({ ok: false, error: { class: "validation" } });
  if (!got.ok) {
    expect(got.error.message).toContain("JIRA_API_TOKEN");
    expect(got.error.message).toContain("security add-generic-password");
    expect(got.error.message).not.toContain(TOKEN);
  }
  expect(fx.requests).toEqual([]);
});
