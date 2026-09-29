import { FakeClock } from "@bayon/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  FIXTURE_HOST,
  checkRun,
  commitStatus,
  fixtureRemote,
  startForgeFixture,
  type ForgeFixture,
} from "./fixtures.js";
import {
  FORGE_CHECKS_PER_PAGE,
  FORGE_CHECK_PAGES_MAX,
  UNNAMED_CHECK,
  checkRunState,
  githubForge,
  statusState,
} from "./github.js";
import type { ForgeHttp } from "./http.js";

// A commit's checks against the local fixture forge: the check runs and the combined
// status merged, both paged, every guard of the floor on every page, and a list that cannot be read
// whole refused rather than cut.

const TOKEN = "a-secret-forge-token";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const remote = fixtureRemote();

let fixture: ForgeFixture;
beforeEach(async () => {
  fixture = await startForgeFixture();
});
afterEach(async () => {
  await fixture.close();
});

const http = (): ForgeHttp => ({
  fetch: fixture.fetchVia(),
  token: TOKEN,
  host: FIXTURE_HOST,
  clock: new FakeClock(1_700_000_000_000),
  timeoutMs: 2_000,
});

const runs = (n: number, prefix = "run") =>
  Array.from({ length: n }, (_, i) =>
    checkRun(`${prefix}-${String(i)}`, "completed", "success"),
  );

describe("the states", () => {
  test("a check run: running is pending; each conclusion maps; stale or none waits", () => {
    expect(checkRunState("queued", null)).toBe("pending");
    expect(checkRunState("in_progress", null)).toBe("pending");
    expect(checkRunState("completed", "success")).toBe("success");
    expect(checkRunState("completed", "neutral")).toBe("neutral");
    expect(checkRunState("completed", "skipped")).toBe("skipped");
    for (const c of [
      "failure",
      "timed_out",
      "cancelled",
      "action_required",
      "startup_failure",
    ]) {
      expect([c, checkRunState("completed", c)]).toEqual([c, "failure"]);
    }
    expect(checkRunState("completed", "stale")).toBe("pending");
    expect(checkRunState("completed", null)).toBe("pending");
  });

  test("a commit status: error fails as failure does; anything else unknown waits", () => {
    expect(statusState("success")).toBe("success");
    expect(statusState("failure")).toBe("failure");
    expect(statusState("error")).toBe("failure");
    expect(statusState("pending")).toBe("pending");
    expect(statusState("weird")).toBe("pending");
  });
});

test("check runs and statuses are merged into one list, with the token sent to the forge only", async () => {
  fixture.checkRuns.set(SHA, [
    checkRun("build", "completed", "success"),
    checkRun("test", "in_progress", null),
  ]);
  fixture.statuses.set(SHA, [
    commitStatus("legacy/ci", "error", `https://${FIXTURE_HOST}/ci/1`),
  ]);
  const got = await githubForge.listChecks(http(), remote, SHA);
  expect(got).toEqual({
    ok: true,
    value: [
      {
        name: "build",
        state: "success",
        url: `https://${FIXTURE_HOST}/runs/build`,
      },
      {
        name: "test",
        state: "pending",
        url: `https://${FIXTURE_HOST}/runs/test`,
      },
      {
        name: "legacy/ci",
        state: "failure",
        url: `https://${FIXTURE_HOST}/ci/1`,
      },
    ],
  });
  expect(fixture.requests.map((r) => r.path)).toEqual([
    `/repos/an-owner/a-repo/commits/${SHA}/check-runs`,
    `/repos/an-owner/a-repo/commits/${SHA}/status`,
  ]);
  expect(fixture.requests.map((r) => r.query.get("per_page"))).toEqual([
    "100",
    "100",
  ]);
  expect(
    fixture.requests.every((r) => r.authorization === `Bearer ${TOKEN}`),
  ).toBe(true);
});

test("a link off the remote's own forge is dropped, and the name kept", async () => {
  fixture.checkRuns.set(SHA, [
    checkRun("build", "completed", "failure", "https://ci.elsewhere.test/1"),
    checkRun("lint", "completed", "success", "http://forge.test/plain"),
  ]);
  fixture.statuses.set(SHA, [
    commitStatus("deploy", "success", "https://ci.elsewhere.test/2"),
  ]);
  const got = await githubForge.listChecks(http(), remote, SHA);
  expect(got.ok && got.value.map((c) => [c.name, c.url])).toEqual([
    ["build", null],
    ["lint", null],
    ["deploy", null],
  ]);
});

test("names are cleaned before they can reach a finding; an empty one is still a check", async () => {
  fixture.checkRuns.set(SHA, [
    checkRun("evil\u001b[2J\nname", "completed", "failure"),
    checkRun(" \n ", "completed", "failure", null),
  ]);
  const got = await githubForge.listChecks(http(), remote, SHA);
  expect(got.ok && got.value.map((c) => [c.name, c.state])).toEqual([
    ["evil [2J name", "failure"],
    [UNNAMED_CHECK, "failure"],
  ]);
});

test("both lists are paged until their totals: every entry of every page is read", async () => {
  fixture.checkRuns.set(SHA, runs(FORGE_CHECKS_PER_PAGE * 2 + 5));
  fixture.statuses.set(
    SHA,
    Array.from({ length: FORGE_CHECKS_PER_PAGE + 1 }, (_, i) =>
      commitStatus(`s-${String(i)}`, "success"),
    ),
  );
  const got = await githubForge.listChecks(http(), remote, SHA);
  expect(got.ok && got.value).toHaveLength(FORGE_CHECKS_PER_PAGE * 3 + 6);
  expect(
    fixture.requests.map((r) => [
      r.path.split("/").at(-1),
      r.query.get("page"),
    ]),
  ).toEqual([
    ["check-runs", "1"],
    ["check-runs", "2"],
    ["check-runs", "3"],
    ["status", "1"],
    ["status", "2"],
  ]);
});

test("a full last page ends the list at its total, with no empty page asked for", async () => {
  fixture.checkRuns.set(SHA, runs(FORGE_CHECKS_PER_PAGE));
  const got = await githubForge.listChecks(http(), remote, SHA);
  expect(got.ok && got.value).toHaveLength(FORGE_CHECKS_PER_PAGE);
  expect(fixture.requests).toHaveLength(2);
});

test("more pages than the cap is refused, not cut: a failure could be on the next page", async () => {
  fixture.checkRuns.set(
    SHA,
    runs(FORGE_CHECKS_PER_PAGE * FORGE_CHECK_PAGES_MAX + 1),
  );
  const got = await githubForge.listChecks(http(), remote, SHA);
  expect(got.ok).toBe(false);
  if (got.ok) return;
  expect(got.error).toMatchObject({ class: "validation", retryable: false });
  expect(got.error.message).toContain("more than 1000 entries");
  expect(fixture.requests).toHaveLength(FORGE_CHECK_PAGES_MAX);
});

test("a commit id that is not one is refused before any request", async () => {
  for (const sha of ["abc", SHA.toUpperCase(), `${SHA}/../x`, ""]) {
    const got = await githubForge.listChecks(http(), remote, sha);
    expect(got.ok).toBe(false);
  }
  expect(fixture.requests).toHaveLength(0);
});

test("a refusal, a 5xx and an unreadable body keep the floor's rules, on either list", async () => {
  fixture.overrides.push({ status: 404, body: '{"message":"Not Found"}' });
  const missing = await githubForge.listChecks(http(), remote, SHA);
  expect(!missing.ok && missing.error).toMatchObject({
    class: "validation",
    retryable: false,
  });
  expect(!missing.ok && missing.error.message).not.toContain(TOKEN);

  fixture.overrides.push(
    { status: 200, body: '{"total_count":0,"check_runs":[]}' },
    { status: 502, body: "{}" },
  );
  const down = await githubForge.listChecks(http(), remote, SHA);
  expect(!down.ok && down.error).toMatchObject({
    class: "runner_error",
    retryable: true,
  });

  fixture.overrides.push({ status: 200, body: '{"check_runs":"nope"}' });
  const odd = await githubForge.listChecks(http(), remote, SHA);
  expect(!odd.ok && odd.error.message).toContain("cannot read");

  fixture.overrides.push(
    { status: 200, body: '{"total_count":0,"check_runs":[]}' },
    { status: 200, body: '{"statuses":[]}' },
  );
  const oddStatus = await githubForge.listChecks(http(), remote, SHA);
  expect(!oddStatus.ok && oddStatus.error.message).toContain("the statuses of");
});

test("a redirect on a check list is refused, never followed", async () => {
  fixture.overrides.push({ redirect: "https://elsewhere.test/steal" });
  const got = await githubForge.listChecks(http(), remote, SHA);
  expect(!got.ok && got.error.message).toContain("redirect");
  expect(fixture.requests).toHaveLength(1);
});

// The latest run of each check counts: "re-run failed jobs" on the same commit adds
// a run under the same name while the failed one is still listed.
describe("the latest run of a check", () => {
  const T = (min: number) =>
    `2026-09-01T10:${String(min).padStart(2, "0")}:00Z`;
  const run = (state: [string, string | null], at: string | null, id: number) =>
    checkRun(
      "build",
      state[0],
      state[1],
      `https://${FIXTURE_HOST}/runs/${String(id)}`,
      {
        id,
        started_at: at,
      },
    );
  const states = async () => {
    const got = await githubForge.listChecks(http(), remote, SHA);
    return got.ok ? got.value.map((c) => [c.name, c.state, c.url]) : got.error;
  };

  test("the forge is asked for the latest runs explicitly", async () => {
    await githubForge.listChecks(http(), remote, SHA);
    expect(fixture.requests[0]?.query.get("filter")).toBe("latest");
  });

  test("an older failure and a newer success: the success is the check", async () => {
    fixture.checkRuns.set(SHA, [
      run(["completed", "failure"], T(0), 1),
      run(["completed", "success"], T(5), 2),
    ]);
    expect(await states()).toEqual([
      ["build", "success", `https://${FIXTURE_HOST}/runs/2`],
    ]);
  });

  test("a failure newer than a success is the check, whatever order the forge lists them in", async () => {
    fixture.checkRuns.set(SHA, [
      run(["completed", "failure"], T(9), 1),
      run(["completed", "success"], T(5), 2),
    ]);
    expect(await states()).toEqual([
      ["build", "failure", `https://${FIXTURE_HOST}/runs/1`],
    ]);
  });

  test("a rerun still running is newer than the failure it replaces: pending", async () => {
    fixture.checkRuns.set(SHA, [
      run(["completed", "failure"], T(0), 1),
      run(["in_progress", null], T(3), 2),
    ]);
    expect(await states()).toEqual([
      ["build", "pending", `https://${FIXTURE_HOST}/runs/2`],
    ]);
  });

  test("a run not started yet is the oldest; equal starts are told apart by the higher id", async () => {
    fixture.checkRuns.set(SHA, [
      run(["queued", null], null, 9),
      run(["completed", "failure"], T(1), 3),
    ]);
    expect(await states()).toEqual([
      ["build", "failure", `https://${FIXTURE_HOST}/runs/3`],
    ]);
    // Either listing order: the higher id wins the tie.
    for (const listed of [
      [
        run(["completed", "failure"], T(1), 4),
        run(["completed", "success"], T(1), 7),
      ],
      [
        run(["completed", "success"], T(1), 7),
        run(["completed", "failure"], T(1), 4),
      ],
    ]) {
      fixture.checkRuns.set(SHA, listed);
      expect(await states()).toEqual([
        ["build", "success", `https://${FIXTURE_HOST}/runs/7`],
      ]);
    }
  });

  test("a commit status sharing a run's name is not folded into it: both count", async () => {
    fixture.checkRuns.set(SHA, [run(["completed", "success"], T(1), 1)]);
    fixture.statuses.set(SHA, [commitStatus("build", "failure")]);
    expect(await states()).toEqual([
      ["build", "success", `https://${FIXTURE_HOST}/runs/1`],
      ["build", "failure", null],
    ]);
  });

  test("a start that is not a timestamp is a body this cannot read", async () => {
    fixture.checkRuns.set(SHA, [run(["completed", "success"], "yesterday", 1)]);
    const got = await githubForge.listChecks(http(), remote, SHA);
    expect(!got.ok && got.error.message).toContain("cannot read");
  });
});
