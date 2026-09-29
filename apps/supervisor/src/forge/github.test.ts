import { FakeClock } from "@bayon/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  FIXTURE_HOST,
  fixtureRemote,
  pullBody,
  pullPath,
  startForgeFixture,
  type ForgeFixture,
} from "./fixtures.js";
import { githubForge } from "./github.js";
import { retryDelayMs, type ForgeHttp } from "./http.js";

// The forge client against a local HTTP fixture (spike §1.4, §1.8). No test here reaches
// a real forge: the injected fetch sends `https://api.forge.test/…` to a `node:http` server on
// 127.0.0.1, so the client's own https check still runs against an https URL.
//
// The two tests that matter are the last two: a refusal must never name the token in any form, and
// a redirect must never be followed — a 3xx would carry the Authorization header to another host.

const TOKEN = "a-secret-forge-token";
const T0 = 1_700_000_000_000;

let fixture: ForgeFixture;
let clock: FakeClock;
const slept: number[] = [];

beforeEach(async () => {
  fixture = await startForgeFixture();
  clock = new FakeClock(T0);
  slept.length = 0;
});

afterEach(async () => {
  await fixture.close();
});

/** A clock whose `after` records the wait and returns at once: no test ever sleeps. */
const http = (over: Partial<ForgeHttp> = {}): ForgeHttp => ({
  fetch: fixture.fetchVia(),
  token: TOKEN,
  host: FIXTURE_HOST,
  clock: {
    now: () => clock.now(),
    after: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  },
  timeoutMs: 2_000,
  ...over,
});

const ask = {
  remote: fixtureRemote(),
  head: "frm/s1",
  base: "main",
  title: "FRM-12 a change",
  body: "delivered by Bayon",
};

test("opening a pull request asks for an existing one first, then creates it", async () => {
  const opened = await githubForge.openPullRequest(http(), ask);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  expect(opened.value).toEqual({
    url: `https://${FIXTURE_HOST}/pull/1`,
    number: 1,
    reused: false,
  });
  expect(fixture.requests.map((r) => r.method)).toEqual(["GET", "POST"]);
  const [listed, created] = fixture.requests;
  expect(listed?.query.get("head")).toBe("an-owner:frm/s1");
  expect(listed?.query.get("state")).toBe("open");
  expect(JSON.parse(created?.body ?? "{}")).toMatchObject({
    head: "frm/s1",
    base: "main",
    title: "FRM-12 a change",
  });
  // The token goes to this host, in one header, and nowhere else.
  expect(created?.authorization).toBe(`Bearer ${TOKEN}`);
});

test("an open pull request is reused: nothing is created", async () => {
  await githubForge.openPullRequest(http(), ask);
  fixture.requests.length = 0;
  const again = await githubForge.openPullRequest(http(), ask);
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.value).toEqual({
    url: `https://${FIXTURE_HOST}/pull/1`,
    number: 1,
    reused: true,
  });
  expect(fixture.requests.map((r) => r.method)).toEqual(["GET"]);
});

test("a 422 saying one exists re-reads rather than failing", async () => {
  // The list answers empty, then the create is refused, then the list finds it: the race a second
  // pass (or a person) opening the request between our two calls would produce.
  fixture.overrides.push(
    { status: 200, body: "[]" },
    {
      status: 422,
      body: JSON.stringify({
        message: "Validation Failed",
        errors: [{ message: "A pull request already exists." }],
      }),
    },
    {
      status: 200,
      body: JSON.stringify([
        { number: 7, html_url: `https://${FIXTURE_HOST}/pull/7` },
      ]),
    },
  );
  const opened = await githubForge.openPullRequest(http(), ask);
  expect(opened.ok).toBe(true);
  if (opened.ok)
    expect(opened.value).toEqual({
      url: `https://${FIXTURE_HOST}/pull/7`,
      number: 7,
      reused: true,
    });
});

test("a 401 says which secret to check and names no form of the token", async () => {
  fixture.overrides.push({
    status: 401,
    body: JSON.stringify({ message: "Bad credentials" }),
  });
  const opened = await githubForge.openPullRequest(http(), ask);
  expect(opened.ok).toBe(false);
  if (opened.ok) return;
  const { message } = opened.error;
  expect(opened.error.class).toBe("validation");
  expect(opened.error.retryable).toBe(false);
  expect(message).toContain("Bad credentials");
  expect(message).toMatch(/host secret store/);
  for (const form of [
    TOKEN,
    Buffer.from(TOKEN).toString("base64"),
    Buffer.from(TOKEN).toString("base64url"),
    encodeURIComponent(TOKEN),
    `Bearer ${TOKEN}`,
  ]) {
    expect(message, form).not.toContain(form);
  }
});

// Remove `redirect: "error"` from the client and this passes a 302 through instead of refusing it.
test("a redirect is refused, not followed", async () => {
  fixture.overrides.push({ redirect: "https://elsewhere.test/pulls" });
  const opened = await githubForge.openPullRequest(http(), ask);
  expect(opened.ok).toBe(false);
  if (opened.ok) return;
  expect(opened.error.message).toMatch(/redirect, which is refused/);
  expect(opened.error.message).toContain(FIXTURE_HOST);
  // Nothing was sent anywhere else: the fixture saw the one request and no more.
  expect(fixture.requests).toHaveLength(1);
});

test("a rate-limited answer is retried after Retry-After, then succeeds", async () => {
  fixture.overrides.push({
    status: 429,
    body: "{}",
    headers: { "retry-after": "3" },
  });
  const opened = await githubForge.openPullRequest(http(), ask);
  expect(opened.ok).toBe(true);
  expect(slept).toEqual([3_000]);
  expect(fixture.requests.map((r) => r.method)).toEqual(["GET", "GET", "POST"]);
});

test("a 403 with no budget left is rate-limiting too, and giving up is retryable", async () => {
  const limited = {
    status: 403,
    body: "{}",
    headers: { "x-ratelimit-remaining": "0", "retry-after": "1" },
  };
  fixture.overrides.push(limited, limited, limited);
  const opened = await githubForge.openPullRequest(
    http({ maxRetries: 2 }),
    ask,
  );
  expect(opened.ok).toBe(false);
  if (opened.ok) return;
  expect(opened.error.retryable).toBe(true);
  expect(opened.error.message).toMatch(/rate-limiting/);
  expect(slept).toEqual([1_000, 1_000]);
});

test("the retry delay is bounded, and falls back when the forge names none", () => {
  const headers = (h: Record<string, string>) => new Headers(h);
  expect(retryDelayMs(headers({ "retry-after": "2" }), T0)).toBe(2_000);
  expect(retryDelayMs(headers({ "retry-after": "99999" }), T0)).toBe(60_000);
  expect(retryDelayMs(headers({ "retry-after": "soon" }), T0)).toBe(1_000);
  expect(retryDelayMs(headers({}), T0)).toBe(1_000);
  expect(
    retryDelayMs(headers({ "x-ratelimit-reset": String(T0 / 1_000 + 5) }), T0),
  ).toBe(5_000);
});

test("a non-https API base is refused before anything is sent", async () => {
  const opened = await githubForge.openPullRequest(
    http({ fetch: () => Promise.reject(new Error("must not be called")) }),
    { ...ask, remote: { ...ask.remote, apiBase: "http://api.forge.test" } },
  );
  expect(opened.ok).toBe(false);
  if (opened.ok) return;
  expect(opened.error.message).toMatch(/is not an https URL/);
});

test("a body that is not JSON, and one this cannot read, are both refused", async () => {
  fixture.overrides.push({ status: 200, body: "<html>nope</html>" });
  const bad = await githubForge.openPullRequest(http(), ask);
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error.message).toMatch(/not JSON/);

  fixture.overrides.push({ status: 200, body: JSON.stringify([{ nope: 1 }]) });
  const unreadable = await githubForge.openPullRequest(http(), ask);
  expect(unreadable.ok).toBe(false);
  if (!unreadable.ok) {
    expect(unreadable.error.message).toMatch(/cannot read/);
  }
});

test("a body over the cap is refused rather than buffered", async () => {
  fixture.overrides.push({ status: 200, body: "[]".padEnd(5_000, " ") });
  const opened = await githubForge.openPullRequest(
    http({ maxBodyBytes: 100 }),
    ask,
  );
  expect(opened.ok).toBe(false);
  if (opened.ok) return;
  expect(opened.error.message).toMatch(/over 100 bytes/);
});

test("a 500 is retryable and a 404 is not", async () => {
  fixture.overrides.push({ status: 500, body: "{}" });
  const server = await githubForge.openPullRequest(http(), ask);
  expect(server.ok).toBe(false);
  if (!server.ok) expect(server.error.retryable).toBe(true);

  fixture.overrides.push({
    status: 404,
    body: JSON.stringify({ message: "Not Found" }),
  });
  const missing = await githubForge.openPullRequest(http(), ask);
  expect(missing.ok).toBe(false);
  if (!missing.ok) {
    expect(missing.error.retryable).toBe(false);
    expect(missing.error.message).toMatch(/does not show this repository/);
  }
});

// ─── getPullRequest ──────────────────────────────────────────────────────────────

test("a pull request is read by number: open, merged with who and when, or closed unmerged", async () => {
  fixture.details.set(pullPath(3), pullBody(3, "open"));
  fixture.details.set(pullPath(4), pullBody(4, "merged", "a-merger"));
  fixture.details.set(pullPath(5), pullBody(5, "closed"));
  const remote = fixtureRemote();
  expect(await githubForge.getPullRequest(http(), remote, 3)).toEqual({
    ok: true,
    value: {
      state: "open",
      merged: false,
      merged_at: null,
      merged_by: null,
      head_sha: "0123456789abcdef0123456789abcdef01234567",
    },
  });
  expect(await githubForge.getPullRequest(http(), remote, 4)).toMatchObject({
    ok: true,
    value: {
      state: "closed",
      merged: true,
      merged_at: Date.parse("2026-09-01T10:00:00Z"),
      merged_by: "a-merger",
    },
  });
  expect(await githubForge.getPullRequest(http(), remote, 5)).toMatchObject({
    ok: true,
    value: { state: "closed", merged: false, merged_by: null },
  });
  // One GET each, carrying the token, to the repository's own pulls path, and nothing else.
  expect(
    fixture.requests.map((r) => [r.method, r.path, r.authorization]),
  ).toEqual([
    ["GET", pullPath(3), `Bearer ${TOKEN}`],
    ["GET", pullPath(4), `Bearer ${TOKEN}`],
    ["GET", pullPath(5), `Bearer ${TOKEN}`],
  ]);
});

test("a request the forge cannot show is a non-retryable refusal that never names the token", async () => {
  const got = await githubForge.getPullRequest(http(), fixtureRemote(), 9);
  expect(got).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      retryable: false,
      cause: { http_status: 404 },
    },
  });
  fixture.overrides.push({
    status: 401,
    body: JSON.stringify({ message: `bad credentials ${TOKEN}` }),
  });
  const refused = await githubForge.getPullRequest(http(), fixtureRemote(), 9);
  expect(refused.ok).toBe(false);
  expect(JSON.stringify(refused)).not.toContain(TOKEN);
});

test("a forge error answers retryable, a rate limit is retried, a body it cannot read is refused", async () => {
  fixture.overrides.push({ status: 502, body: "{}" });
  expect(
    await githubForge.getPullRequest(http(), fixtureRemote(), 3),
  ).toMatchObject({ ok: false, error: { retryable: true } });

  fixture.details.set(pullPath(3), pullBody(3, "open"));
  fixture.overrides.push({
    status: 429,
    body: "{}",
    headers: { "retry-after": "2" },
  });
  expect(
    await githubForge.getPullRequest(http(), fixtureRemote(), 3),
  ).toMatchObject({ ok: true, value: { state: "open" } });
  expect(slept).toEqual([2_000]);

  fixture.details.set(pullPath(6), { number: 6, state: "weird" });
  expect(
    await githubForge.getPullRequest(http(), fixtureRemote(), 6),
  ).toMatchObject({
    ok: false,
    error: { class: "runner_error", retryable: false },
  });
  // A body for another number is not this request's.
  fixture.details.set(pullPath(7), pullBody(8, "merged"));
  expect(
    await githubForge.getPullRequest(http(), fixtureRemote(), 7),
  ).toMatchObject({ ok: false, error: { class: "runner_error" } });
});

test("a number that is not one is refused before any request", async () => {
  for (const n of [0, -1, 1.5]) {
    expect(
      await githubForge.getPullRequest(http(), fixtureRemote(), n),
      String(n),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  }
  expect(fixture.requests).toEqual([]);
});

test("reading a pull request never follows a redirect", async () => {
  fixture.overrides.push({ redirect: "https://elsewhere.test/steal" });
  const got = await githubForge.getPullRequest(http(), fixtureRemote(), 3);
  expect(got).toMatchObject({ ok: false, error: { retryable: false } });
  expect(fixture.requests).toHaveLength(1);
});

// ─── an earlier change review: what a forge's answer may put in a row ─────────────────────────────────

test("a merger's login is kept when it is one, bots included, and recorded as unknown otherwise", async () => {
  const remote = fixtureRemote();
  const cases: [string, string][] = [
    ["a-merger", "a-merger"],
    ["Octo-Cat9", "Octo-Cat9"],
    ["deploy-app[bot]", "deploy-app[bot]"],
    ["-leading", "unknown"],
    ["double--hyphen", "unknown"],
    ["x".repeat(40), "unknown"],
    ["<script>alert(1)</script>", "unknown"],
    ["someone @here", "unknown"],
    ["name[bot][bot]", "unknown"],
  ];
  for (const [i, [login, want]] of cases.entries()) {
    const n = i + 1;
    fixture.details.set(pullPath(n), pullBody(n, "merged", login));
    expect(
      await githubForge.getPullRequest(http(), remote, n),
      login,
    ).toMatchObject({ ok: true, value: { merged: true, merged_by: want } });
  }
});

test("an answer whose page is not on the remote's own forge is refused as malformed", async () => {
  const remote = fixtureRemote();
  for (const url of [
    "https://elsewhere.test/pull/1",
    "http://forge.test/pull/1",
    "https://user:pw@forge.test/pull/1",
    "https://forge.test.evil.test/pull/1",
    "javascript:alert(1)",
  ]) {
    fixture.details.set(pullPath(1), {
      ...(pullBody(1, "open") as object),
      html_url: url,
    });
    expect(
      await githubForge.getPullRequest(http(), remote, 1),
      url,
    ).toMatchObject({
      ok: false,
      error: { class: "runner_error", retryable: false },
    });
  }
  // The same rule for a request opened or found for a delivery.
  fixture.overrides.push({
    status: 200,
    body: JSON.stringify([
      { number: 4, html_url: "https://elsewhere.test/pull/4" },
    ]),
  });
  expect(await githubForge.openPullRequest(http(), ask)).toMatchObject({
    ok: false,
    error: { class: "runner_error" },
  });
  fixture.overrides.push(
    { status: 200, body: "[]" },
    {
      status: 201,
      body: JSON.stringify({
        number: 5,
        html_url: "https://elsewhere.test/pull/5",
      }),
    },
  );
  expect(await githubForge.openPullRequest(http(), ask)).toMatchObject({
    ok: false,
    error: { class: "runner_error" },
  });
  // A www. alias of the forge's own host is the forge.
  fixture.details.set(pullPath(2), {
    ...(pullBody(2, "open") as object),
    html_url: "https://www.forge.test/pull/2",
  });
  expect(await githubForge.getPullRequest(http(), remote, 2)).toMatchObject({
    ok: true,
  });
});
