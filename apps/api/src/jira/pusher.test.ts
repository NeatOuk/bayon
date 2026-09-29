// The Jira pusher against a temp-file DB and an in-memory Jira, never a real one: a
// first boot pushes no history; a ticket's move is filed once and sent once however often it is
// read; a delivered pull request moves the issue to review and comments the link; a retryable
// failure waits its backoff and a 401 fails for good; the mirror's own writes and tickets that were
// never mirrored push nothing; and no stored error names the token.
import {
  FakeClock,
  JIRA_TOKEN_SECRET,
  err,
  jiraFingerprint,
  ok,
  type ComplexityColumns,
} from "@bayon/core";
import {
  findTicketByFingerprint,
  getTicket,
  jiraPushesOf,
  type Db,
} from "@bayon/db";
import { mirrorJiraPage, transitionTicket } from "@bayon/db/api";
import {
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
  type TempDb,
} from "@bayon/db/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import { JiraPusher } from "./pusher.js";
import { NO_SOURCE, SITE_MOVED } from "./push-deliver.js";
import {
  PUSH_EMAIL,
  PUSH_SITE,
  PUSH_TOKEN,
  fakeJira,
  type FakeJira,
} from "./push-fixtures.js";
import type { Fetch } from "../atlassian/client.js";
import type { JiraTokenStore } from "./token.js";

const T0 = 1_700_000_000_000;
const HOST = new URL(PUSH_SITE).host;
const PR = "https://forge.example/o/r/pull/7";
const BASIC64 = Buffer.from(`${PUSH_EMAIL}:${PUSH_TOKEN}`).toString("base64");

const COMPLEXITY: ComplexityColumns = {
  complexity_score: 0,
  complexity_tier: "standard",
  non_trivial: 0,
  complexity_factors_json: '{"facts":{}}',
};

const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

let db: Db;
let clock: FakeClock;
let jira: FakeJira;
let stored: string | null;
const warned: string[] = [];

const token: JiraTokenStore = {
  kind: "keychain",
  keychain: { service: "foreman-0123456789ab", owner: false },
  secrets: {
    get: async (name) =>
      name === JIRA_TOKEN_SECRET && stored !== null
        ? ok(stored)
        : err({ class: "not_found", message: "no token", retryable: false }),
  },
};

const logger = {
  warn: (m: string) => warned.push(m),
  error: (m: string) => warned.push(m),
};

beforeEach(async () => {
  clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  opened.push(t);
  db = t.db;
  jira = fakeJira();
  stored = PUSH_TOKEN;
  warned.length = 0;
  unwrap(
    await seedRows(db, {
      workspaces: [
        {
          id: "P",
          name: "P",
          kind: "single",
          jira_url: PUSH_SITE,
          jira_email: PUSH_EMAIL,
          jira_jql: 'status = "To Do"',
          jira_status_map_json: JSON.stringify({
            started: "In Progress",
            in_review: "In Review",
            done: "Done",
          }),
        },
      ],
      repos: [
        { id: "R", name: "R", mirror_path: "/m", doctrine_paths_json: "[]" },
      ],
    }),
  );
  unwrap(
    await mirrorJiraPage(db, {
      workspaceId: "P",
      host: HOST,
      items: [
        {
          issue_id: "10001",
          fingerprint: jiraFingerprint(HOST, "10001"),
          origin_ref: "ABC-1",
          title: "one",
          body_md: "",
          type: "feature",
          priority: 3,
          status_category: "new",
          status_name: "To Do",
        },
      ],
      complexity: COMPLEXITY,
    }),
  );
  jira.issues.set("ABC-1", "To Do");
  jira.transitions.set("ABC-1", [
    { id: "11", to: "In Progress" },
    { id: "31", to: "In Review" },
    { id: "41", to: "Done" },
  ]);
});

const pusherWith = (fetch: Fetch) =>
  new JiraPusher({ db, clock, token, fetch, logger });
const pusher = () => pusherWith(jira.fetch);

const mirrored = async () => {
  const t = unwrap(
    await findTicketByFingerprint(db, jiraFingerprint(HOST, "10001")),
  );
  if (t === null) throw new Error("no mirrored ticket");
  return t;
};

async function move(id: string, ...path: string[]) {
  for (const to of path) {
    const t = unwrap(await getTicket(db, id));
    unwrap(
      await transitionTicket(
        db,
        {
          id,
          version: t.version,
          to,
          by: { actor_kind: "operator", actor_id: "operator" },
        },
        () => ok(undefined),
      ),
    );
  }
}

const posts = () => jira.seen.filter((r) => r.method === "POST");
const pushes = async (id: string) => unwrap(await jiraPushesOf(db, id));

test("a first boot pushes no history; a later move is filed and sent once", async () => {
  const t = await mirrored();
  await move(t.id, "prioritized", "staffed");
  const p = pusher();
  await p.tick();
  expect(await pushes(t.id)).toEqual([]);
  expect(jira.seen).toEqual([]);

  await move(t.id, "spiking");
  // Started already moved nothing: the first boot's `staffed` is history. Spiking starts it now.
  await p.tick();
  await p.tick();
  expect(
    (await pushes(t.id)).map((r) => [r.kind, r.moment, r.state, r.attempts]),
  ).toEqual([["transition", "started", "sent", 1]]);
  expect(jira.issues.get("ABC-1")).toBe("In Progress");
  expect(posts()).toHaveLength(1);
});

test("a delivered pull request moves the issue to review and comments the link", async () => {
  const t = await mirrored();
  await pusher().tick();
  unwrap(
    await seedRows(db, {
      deliveries: [
        {
          id: "D1",
          ticket_id: t.id,
          repo_id: "R",
          branch: "frm/x",
          state: "pr_open",
          pr_url: PR,
          started_at: T0,
        },
      ],
      ticket_links: [{ ticket_id: t.id, kind: "pr", url: PR, created_at: T0 }],
    }),
  );
  await pusher().tick();
  expect((await pushes(t.id)).map((r) => [r.kind, r.moment, r.state])).toEqual([
    ["transition", "in_review", "sent"],
    ["comment", "in_review", "sent"],
  ]);
  expect(jira.issues.get("ABC-1")).toBe("In Review");
  expect(jira.comments.get("ABC-1")).toEqual([
    {
      body: expect.objectContaining({
        type: "doc",
        content: [
          expect.objectContaining({
            content: [
              { type: "text", text: "Pull request: " },
              expect.objectContaining({ text: PR }),
            ],
          }),
        ],
      }),
    },
  ]);
});

test("a retryable failure waits its backoff, then goes", async () => {
  const t = await mirrored();
  const p = pusher();
  await p.tick();
  await move(t.id, "prioritized", "staffed");
  jira.next.push({ status: 503 });
  await p.tick();
  expect(await pushes(t.id)).toEqual([
    expect.objectContaining({
      state: "pending",
      attempts: 1,
      next_attempt_at: T0 + 30_000,
      last_error: expect.stringContaining("HTTP 503"),
    }),
  ]);
  await p.tick();
  expect(jira.seen).toHaveLength(1);
  await clock.advance(30_000);
  await p.tick();
  expect(await pushes(t.id)).toEqual([
    expect.objectContaining({ state: "sent", attempts: 2, last_error: null }),
  ]);
});

test("a 401 fails for good, naming the permissions; no stored error names the token", async () => {
  const t = await mirrored();
  const p = pusher();
  await p.tick();
  await move(t.id, "prioritized", "staffed");
  jira.next.push({
    status: 401,
    body: JSON.stringify({ errorMessages: [PUSH_TOKEN, BASIC64] }),
  });
  await p.tick();
  const [row] = await pushes(t.id);
  expect(row).toMatchObject({ state: "failed", attempts: 1 });
  expect(row?.last_error).toContain("Transition Issues and Add Comments");
  for (const text of [row?.last_error ?? "", ...warned]) {
    expect(text).not.toContain(PUSH_TOKEN);
    expect(text).not.toContain(BASIC64);
  }
  await clock.advance(10 * 3_600_000);
  await p.tick();
  expect(jira.seen).toHaveLength(1);
});

test("a thrown error or a 400 echoing the token is stored scrubbed", async () => {
  const t = await mirrored();
  const p = pusher();
  await p.tick();
  await move(t.id, "prioritized", "staffed");
  jira.next.push({ throws: new Error(`socket ${PUSH_TOKEN} ${BASIC64}`) });
  await p.tick();
  await clock.advance(30_000);
  jira.next.push({
    status: 400,
    body: JSON.stringify({ errorMessages: [`bad ${PUSH_TOKEN}`] }),
  });
  await p.tick();
  const [row] = await pushes(t.id);
  expect(row).toMatchObject({ state: "failed", attempts: 2 });
  expect(row?.last_error).toContain("<redacted>");
  for (const text of [row?.last_error ?? "", ...warned]) {
    expect(text).not.toContain(PUSH_TOKEN);
    expect(text).not.toContain(BASIC64);
  }
});

test("no token in the store: the push waits for one, and goes once it is there", async () => {
  const t = await mirrored();
  const p = pusher();
  await p.tick();
  await move(t.id, "prioritized", "staffed");
  stored = null;
  await p.tick();
  expect(await pushes(t.id)).toEqual([
    expect.objectContaining({
      state: "pending",
      last_error: expect.stringContaining(JIRA_TOKEN_SECRET),
    }),
  ]);
  expect(jira.seen).toEqual([]);
  stored = PUSH_TOKEN;
  await clock.advance(30_000);
  await p.tick();
  expect((await pushes(t.id))[0]?.state).toBe("sent");
});

test("the mirror's own events and tickets never mirrored push nothing", async () => {
  const t = await mirrored();
  const p = pusher();
  await p.tick();
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(90, { status: "prioritized", workspace_id: "P" })],
      ticket_events: [
        {
          ticket_id: t.id,
          ts: T0,
          actor_kind: "operator",
          actor_id: `jira:${HOST}`,
          kind: "transition",
          from_status: "prioritized",
          to_status: "staffed",
        },
      ],
    }),
  );
  await move("ticket-90", "staffed");
  await p.tick();
  expect(await pushes(t.id)).toEqual([]);
  expect(await pushes("ticket-90")).toEqual([]);
  expect(jira.seen).toEqual([]);
});

test("a move in a project with no Jira source files nothing", async () => {
  const t = await mirrored();
  const p = pusher();
  await p.tick();
  await move(t.id, "prioritized", "staffed");
  // Filed, then the source goes before the send.
  unwrap(
    await updateRowForTest(db, "workspaces", "P", {
      jira_url: null,
      jira_email: null,
      jira_jql: null,
    }),
  );
  await p.tick();
  expect(await pushes(t.id)).toEqual([]);
});

test("filed, then the source goes: skipped with the reason", async () => {
  const t = await mirrored();
  const p = pusher();
  await p.tick();
  await move(t.id, "prioritized", "staffed");
  jira.next.push({ status: 503 });
  await p.tick();
  unwrap(
    await updateRowForTest(db, "workspaces", "P", {
      jira_url: null,
      jira_email: null,
      jira_jql: null,
    }),
  );
  await clock.advance(30_000);
  await p.tick();
  expect(await pushes(t.id)).toEqual([
    expect.objectContaining({ state: "skipped", last_error: NO_SOURCE }),
  ]);
});

test("start and stop: the loop ticks on the clock and stops cleanly", async () => {
  const t = await mirrored();
  const p = new JiraPusher({
    db,
    clock,
    token,
    fetch: jira.fetch,
    logger,
    pollMs: 1_000,
  });
  p.start();
  p.start();
  await clock.advance(1_000);
  await move(t.id, "prioritized", "staffed");
  for (let i = 0; i < 20 && jira.seen.length === 0; i += 1)
    await clock.advance(1_000);
  await p.stop();
  expect(jira.issues.get("ABC-1")).toBe("In Progress");
});

test("filed, then the project moves to another site: skipped, its key is the old site's", async () => {
  const t = await mirrored();
  const p = pusher();
  await p.tick();
  await move(t.id, "prioritized", "staffed");
  jira.next.push({ status: 503 });
  await p.tick();
  unwrap(
    await updateRowForTest(db, "workspaces", "P", {
      jira_url: "https://elsewhere.atlassian.net",
    }),
  );
  await clock.advance(30_000);
  await p.tick();
  expect(await pushes(t.id)).toEqual([
    expect.objectContaining({ state: "skipped", last_error: SITE_MOVED }),
  ]);
  expect(jira.seen).toHaveLength(1);
});

test("a push that keeps failing retryably fails after its sixth attempt", async () => {
  const t = await mirrored();
  const p = pusher();
  await p.tick();
  await move(t.id, "prioritized", "staffed");
  for (let i = 0; i < 6; i += 1) {
    jira.next.push({ status: 503 });
    await p.tick();
    await clock.advance(21_600_000);
  }
  await p.tick();
  expect(await pushes(t.id)).toEqual([
    expect.objectContaining({ state: "failed", attempts: 6 }),
  ]);
  expect(jira.seen).toHaveLength(6);
});

test("a comment that landed but whose answer was lost is not posted twice on the retry", async () => {
  const t = await mirrored();
  unwrap(
    await updateRowForTest(db, "workspaces", "P", {
      jira_status_map_json: null,
    }),
  );
  const p = pusher();
  await p.tick();
  unwrap(
    await seedRows(db, {
      deliveries: [
        {
          id: "D1",
          ticket_id: t.id,
          repo_id: "R",
          branch: "frm/x",
          state: "pr_open",
          pr_url: PR,
          started_at: T0,
        },
      ],
      ticket_links: [{ ticket_id: t.id, kind: "pr", url: PR, created_at: T0 }],
    }),
  );
  // The POST reaches Jira, but its answer never comes back.
  const landed = jira.fetch;
  let lost = true;
  const flaky = pusherWith(async (url, init) => {
    const res = await landed(url, init);
    if (init.method === "POST" && lost) {
      lost = false;
      return new Response("", { status: 504 });
    }
    return res;
  });
  await flaky.tick();
  expect(jira.comments.get("ABC-1")).toHaveLength(1);
  expect(await pushes(t.id)).toEqual([
    expect.objectContaining({ kind: "comment", state: "pending", attempts: 1 }),
  ]);
  await clock.advance(30_000);
  await flaky.tick();
  expect(jira.comments.get("ABC-1")).toHaveLength(1);
  expect(await pushes(t.id)).toEqual([
    expect.objectContaining({ kind: "comment", state: "sent", attempts: 2 }),
  ]);
});
