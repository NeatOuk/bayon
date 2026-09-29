import { FakeClock, forgeTokenSecret } from "@bayon/core";
import {
  dumpAllRows,
  seedRows,
  tempDb,
  unwrap,
  updateRowForTest,
} from "@bayon/db/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  fixtureRemote,
  pullBody,
  pullPath,
  startForgeFixture,
  type ForgeFixture,
} from "../forge/fixtures.js";
import { PR_SWEEP_MAX, sweepPullRequests } from "./pull-requests.js";
import {
  PROJECT,
  T0,
  TICKET,
  makeWorld,
  projectRows,
  secretsOf,
  type RepoOnDisk,
  type World,
} from "./testing/world.js";

// The pull-request sweep against the fixture forge: no test here reaches a real one,
// and none needs git — the rows stand in for a delivery that already opened its requests.

const TOKEN = "a-secret-forge-token";
const PR_URL = (n: number) => `https://forge.test/pull/${n}`;

let fixture: ForgeFixture;
let world: World | null = null;
let temp: { cleanup(): void } | null = null;

beforeEach(async () => {
  fixture = await startForgeFixture();
});

afterEach(async () => {
  world?.cleanup();
  world = null;
  temp?.cleanup();
  temp = null;
  await fixture.close();
});

/** A repo as the rows name it: nothing on disk, since nothing here runs git. */
const repo = (id: string): RepoOnDisk => ({
  id,
  src: `/src/${id}`,
  mirror: `/mirrors/${id}.git`,
  remote: `https://forge.test/an-owner/${id}.git`,
  head: "a".repeat(40),
});

interface Spec {
  readonly repos?: readonly string[];
  readonly status?: string;
  readonly closeOnMerge?: 0 | 1;
  readonly harness?: boolean;
  readonly token?: boolean;
}

async function worldWith(s: Spec = {}): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  temp = t;
  const w = makeWorld(t.db, clock, {
    secrets: secretsOf(
      s.token === false ? {} : { [forgeTokenSecret("github")]: TOKEN },
    ),
    forgeFetch: fixture.fetchVia(),
    forgeRemoteOf: () => fixtureRemote(),
  });
  world = w;
  const ids = s.repos ?? ["r1"];
  const rows = projectRows({
    repos: ids.map(repo),
    kind: ids.length > 1 ? "multi" : "single",
    status: s.status ?? "qa_human",
  });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      workspaces: rows.workspaces.map((ws) => ({
        ...ws,
        close_on_merge: s.closeOnMerge ?? 1,
      })),
      gates:
        s.harness === true
          ? [
              {
                id: "G-qa",
                ticket_id: TICKET,
                kind: "qa_harness",
                state: "running",
                subject_kind: "commit",
                subject_ref: "abc",
                started_at: T0,
              },
            ]
          : [],
      deliveries: ids.map((id, i) => ({
        id: `D-${id}`,
        ticket_id: TICKET,
        repo_id: id,
        branch: "frm/s1",
        head_sha: "a".repeat(40),
        remote_host: "forge.test",
        remote_url: `https://forge.test/an-owner/${id}.git`,
        state: "pr_open" as const,
        pr_url: PR_URL(i + 1),
        pr_number: i + 1,
        started_at: T0,
      })),
    }),
  );
  return w;
}

const statusOf = async (w: World): Promise<unknown> =>
  (unwrap(await dumpAllRows(w.db)).tickets ?? []).map(
    (r) => (r as { status: string }).status,
  )[0];

const rowsOf = async (w: World) => unwrap(await dumpAllRows(w.db));

test("a merged pull request closes the ticket, with who merged it, in one pass", async () => {
  const w = await worldWith();
  fixture.details.set(pullPath(1), pullBody(1, "merged", "a-merger"));
  expect(await sweepPullRequests(w.ctx)).toEqual({
    looked: 1,
    merged: 1,
    closed: 0,
    done: 1,
    recorded: 1,
    failed: 0,
    budgetSpent: false,
  });
  expect(await statusOf(w)).toBe("done");
  const rows = await rowsOf(w);
  expect(rows.deliveries).toMatchObject([
    {
      state: "merged",
      merged_by: "a-merger",
      merged_at: Date.parse("2026-09-01T10:00:00Z"),
    },
  ]);
  const transition = (
    rows.ticket_events as { kind: string; payload_json: string }[]
  ).find((e) => e.kind === "transition");
  expect(JSON.parse(transition?.payload_json ?? "{}")).toMatchObject({
    rule: "merge_close",
    merged_by: "a-merger",
    pr_urls: [PR_URL(1)],
  });
  // One GET, with the token, and nothing else sent anywhere.
  expect(fixture.requests.map((r) => [r.method, r.path])).toEqual([
    ["GET", pullPath(1)],
  ]);
  expect(fixture.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  // Done: not a candidate again, so a second pass asks the forge nothing.
  await sweepPullRequests(w.ctx);
  expect(fixture.requests).toHaveLength(1);
});

test("one merged of two: recorded, the ticket stays; the second merge closes it", async () => {
  const w = await worldWith({ repos: ["r1", "r2"] });
  fixture.details.set(pullPath(1), pullBody(1, "merged"));
  fixture.details.set(pullPath(2), pullBody(2, "open"));
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    merged: 1,
    done: 0,
  });
  expect(await statusOf(w)).toBe("qa_human");
  fixture.details.set(pullPath(2), pullBody(2, "merged"));
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    merged: 1,
    done: 1,
  });
  expect(await statusOf(w)).toBe("done");
});

test("a request closed without merging asks the operator once; the ticket does not move", async () => {
  const w = await worldWith();
  fixture.details.set(pullPath(1), pullBody(1, "closed"));
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    closed: 1,
    done: 0,
  });
  expect(await statusOf(w)).toBe("qa_human");
  const requests = (await rowsOf(w)).human_requests as { question: string }[];
  expect(requests.map((r) => r.question)).toEqual([
    `PR closed without merging: ${PR_URL(1)}`,
  ]);
  // The row is closed, so the ticket is no longer a candidate: no GET, and no second request.
  const before = await rowsOf(w);
  await sweepPullRequests(w.ctx);
  expect(fixture.requests).toHaveLength(1);
  expect(await rowsOf(w)).toEqual(before);
});

// a ticket already done when it was delivered — its request is still followed to its end,
// and that end moves nothing.
test("a done ticket's request closed later is recorded closed, with no step, and says the work never landed", async () => {
  const w = await worldWith({ status: "done" });
  fixture.details.set(pullPath(1), pullBody(1, "open"));
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    looked: 1,
    recorded: 0,
  });
  fixture.details.set(pullPath(1), pullBody(1, "closed"));
  expect(await sweepPullRequests(w.ctx)).toEqual({
    looked: 1,
    merged: 0,
    closed: 1,
    done: 0,
    recorded: 1,
    failed: 0,
    budgetSpent: false,
  });
  expect(await statusOf(w)).toBe("done");
  const rows = await rowsOf(w);
  expect(rows.deliveries).toMatchObject([{ state: "closed" }]);
  expect(
    (rows.human_requests as { question: string }[]).map((r) => r.question),
  ).toEqual([`PR closed without merging on a done ticket: ${PR_URL(1)}`]);
  const kinds = (rows.ticket_events as { kind: string }[]).map((e) => e.kind);
  expect(kinds).not.toContain("transition");
  // Settled: not a candidate again, so the next pass asks the forge nothing.
  await sweepPullRequests(w.ctx);
  expect(fixture.requests).toHaveLength(2);
});

test("a done ticket's request merged later is recorded merged, and the ticket takes no step", async () => {
  const w = await worldWith({ status: "done" });
  fixture.details.set(pullPath(1), pullBody(1, "merged", "a-merger"));
  expect(await sweepPullRequests(w.ctx)).toEqual({
    looked: 1,
    merged: 1,
    closed: 0,
    done: 0,
    recorded: 1,
    failed: 0,
    budgetSpent: false,
  });
  expect(await statusOf(w)).toBe("done");
  const rows = await rowsOf(w);
  expect(rows.deliveries).toMatchObject([
    { state: "merged", merged_by: "a-merger" },
  ]);
  const kinds = (rows.ticket_events as { kind: string }[]).map((e) => e.kind);
  expect(kinds).not.toContain("transition");
  await sweepPullRequests(w.ctx);
  expect(fixture.requests).toHaveLength(1);
});

test("a re-poll of a request still open is its GET and nothing else", async () => {
  const w = await worldWith();
  fixture.details.set(pullPath(1), pullBody(1, "open"));
  const before = await rowsOf(w);
  for (let pass = 0; pass < 3; pass += 1) {
    expect(await sweepPullRequests(w.ctx)).toMatchObject({
      looked: 1,
      merged: 0,
      closed: 0,
      done: 0,
      // Nothing new: the writer is not called at all.
      recorded: 0,
    });
  }
  expect(await rowsOf(w)).toEqual(before);
  expect(fixture.requests.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
});

test("a merge at qa_harness supersedes the harness still running", async () => {
  const w = await worldWith({ status: "qa_harness", harness: true });
  fixture.details.set(pullPath(1), pullBody(1, "merged"));
  expect(await sweepPullRequests(w.ctx)).toMatchObject({ done: 1 });
  const rows = await rowsOf(w);
  expect(await statusOf(w)).toBe("done");
  expect(rows.gates).toMatchObject([{ id: "G-qa", state: "failed" }]);
  expect(rows.commands).toEqual([]);
});

test("close_on_merge off: the merge is recorded, the ticket stays, and nothing is polled again", async () => {
  const w = await worldWith({ closeOnMerge: 0 });
  fixture.details.set(pullPath(1), pullBody(1, "merged"));
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    merged: 1,
    done: 0,
  });
  expect(await statusOf(w)).toBe("qa_human");
  expect((await rowsOf(w)).deliveries).toMatchObject([{ state: "merged" }]);
  await sweepPullRequests(w.ctx);
  expect(fixture.requests).toHaveLength(1);
  // Switched on later: the next pass closes it, without asking the forge again.
  unwrap(
    await updateRowForTest(w.db, "workspaces", PROJECT, { close_on_merge: 1 }),
  );
  expect(await sweepPullRequests(w.ctx)).toMatchObject({ done: 1 });
  expect(fixture.requests).toHaveLength(1);
});

test("a request the forge cannot show is recorded, scrubbed, and asked about once", async () => {
  const w = await worldWith();
  fixture.overrides.push({
    status: 401,
    body: JSON.stringify({ message: `token ${TOKEN} is not valid` }),
  });
  expect(await sweepPullRequests(w.ctx)).toMatchObject({ failed: 0 });
  const first = await rowsOf(w);
  const row = (first.deliveries as { state: string; error: string }[])[0];
  expect(row?.state).toBe("pr_open");
  expect(row?.error).toMatch(/HTTP 401/);
  expect(JSON.stringify(first)).not.toContain(TOKEN);
  expect(first.human_requests).toHaveLength(1);
  // Still refused next pass: its GET again, and nothing new written or filed.
  fixture.overrides.push({
    status: 401,
    body: JSON.stringify({ message: `token ${TOKEN} is not valid` }),
  });
  expect(await sweepPullRequests(w.ctx)).toMatchObject({ recorded: 0 });
  expect(await rowsOf(w)).toEqual(first);
  // A 404 on a request that is gone: a new error recorded; the request already filed stands.
  await sweepPullRequests(w.ctx);
  expect(
    ((await rowsOf(w)).deliveries as { error: string }[])[0]?.error,
  ).toMatch(/HTTP 404/);
  expect((await rowsOf(w)).human_requests).toHaveLength(1);
  // It reads again: the error is cleared.
  fixture.details.set(pullPath(1), pullBody(1, "open"));
  await sweepPullRequests(w.ctx);
  expect(
    ((await rowsOf(w)).deliveries as { error: string | null }[])[0]?.error,
  ).toBeNull();
  expect(fixture.requests.every((r) => !r.path.includes(TOKEN))).toBe(true);
});

test("a retryable forge error is recorded and files nothing", async () => {
  const w = await worldWith();
  fixture.overrides.push({ status: 503, body: "{}" });
  await sweepPullRequests(w.ctx);
  const rows = await rowsOf(w);
  expect((rows.deliveries as { error: string }[])[0]?.error).toMatch(/503/);
  expect(rows.human_requests).toEqual([]);
});

test("no forge token: nothing is sent, and the operator is told which secret to store", async () => {
  const w = await worldWith({ token: false });
  await sweepPullRequests(w.ctx);
  expect(fixture.requests).toEqual([]);
  const rows = await rowsOf(w);
  expect((rows.deliveries as { error: string }[])[0]?.error).toBe(
    `no ${forgeTokenSecret("github")} in the host secret store`,
  );
  expect(rows.human_requests).toHaveLength(1);
});

test("a remote that is no forge is refused without a request to anywhere", async () => {
  const w = await worldWith();
  const ctx = { ...w.ctx, forgeRemoteOf: () => null };
  await sweepPullRequests(ctx);
  expect(fixture.requests).toEqual([]);
  expect(
    ((await rowsOf(w)).deliveries as { error: string }[])[0]?.error,
  ).toMatch(/is not a forge Bayon can read a pull request on/);
});

test("the budget stops a pass between tickets, and the next carries on from the cursor", async () => {
  const w = await worldWith();
  fixture.details.set(pullPath(1), pullBody(1, "open"));
  expect(await sweepPullRequests(w.ctx, { budgetMs: 0 })).toMatchObject({
    looked: 0,
    budgetSpent: true,
  });
  expect(fixture.requests).toEqual([]);
  expect(await sweepPullRequests(w.ctx)).toMatchObject({ looked: 1 });
  expect(PR_SWEEP_MAX).toBe(25);
});

test("a credential in the recorded origin never reaches the stored error", async () => {
  const w = await worldWith();
  // A row from before 039 has no remote_url: the repo's origin stands in, userinfo and all.
  unwrap(
    await updateRowForTest(w.db, "deliveries", "D-r1", { remote_url: null }),
  );
  unwrap(
    await updateRowForTest(w.db, "repos", "r1", {
      origin_url: "https://someone:pw-in-the-url@forge.test/an-owner/r1.git",
    }),
  );
  fixture.overrides.push({
    status: 403,
    body: JSON.stringify({ message: "denied for someone:pw-in-the-url" }),
  });
  await sweepPullRequests(w.ctx);
  const rows = await rowsOf(w);
  const error = (rows.deliveries as { error: string }[])[0]?.error ?? "";
  expect(error).toMatch(/HTTP 403/);
  expect(JSON.stringify(rows)).not.toContain(
    "denied for someone:pw-in-the-url",
  );
  expect(error).not.toContain("pw-in-the-url");
});
