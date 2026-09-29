// The Jira pusher's reads and outbox against a real temp database: a first boot reads no
// history, moves and delivered pull requests past the watermarks are read with their mirrored
// tickets, a key filed twice is one row, a later move supersedes a pending one, and a push is
// claimed then settled.
import {
  FakeClock,
  jiraFingerprint,
  ok,
  pushesOf,
  type ComplexityColumns,
  type JiraMirrorItem,
  type NewJiraPush,
} from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
  type TempDb,
} from "../testing.js";
import { mirrorJiraPage } from "./jira-mirror.js";
import { jiraPushSources } from "./jira-push-sources.js";
import {
  SUPERSEDED,
  claimJiraPush,
  dueJiraPushes,
  fileJiraPushes,
  jiraPushesOf,
  settleJiraPush,
} from "./jira-pushes.js";
import { transitionTicket, type Decide } from "./ticket-transition.js";
import { findTicketByFingerprint, getTicket } from "./tickets.js";

const T0 = 1_700_000_000_000;
const HOST = "example.atlassian.net";
const SITE = `https://${HOST}`;
const PR = "https://forge.example/o/r/pull/7";
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

const COMPLEXITY: ComplexityColumns = {
  complexity_score: 0,
  complexity_tier: "standard",
  non_trivial: 0,
  complexity_factors_json: '{"facts":{}}',
};

const item = (id: string): JiraMirrorItem => ({
  issue_id: id,
  fingerprint: jiraFingerprint(HOST, id),
  origin_ref: `ABC-${id.slice(-1)}`,
  title: `Issue ${id}`,
  body_md: "",
  type: "feature",
  priority: 3,
  status_category: "new",
  status_name: "To Do",
});

const allow: Decide = () => ok(undefined);

async function fresh() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        {
          id: "P-A",
          name: "P-A",
          kind: "single",
          jira_url: SITE,
          jira_email: "someone@example.com",
          jira_jql: "project = ABC",
          jira_status_map_json: JSON.stringify({
            started: "In Progress",
            in_review: "In Review",
            done: "Done",
          }),
        },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
      repos: [
        { id: "R", name: "R", mirror_path: "/m", doctrine_paths_json: "[]" },
      ],
    }),
  );
  unwrap(
    await mirrorJiraPage(t.db, {
      workspaceId: "P-A",
      host: HOST,
      items: [item("10001"), item("10002")],
      complexity: COMPLEXITY,
    }),
  );
  return { db: t.db, clock };
}

const ticketOf = async (db: TempDb["db"], issue: string) => {
  const t = unwrap(
    await findTicketByFingerprint(db, jiraFingerprint(HOST, issue)),
  );
  if (t === null) throw new Error(`no ticket for ${issue}`);
  return t;
};

async function move(db: TempDb["db"], id: string, to: string) {
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
      allow,
    ),
  );
}

/** One tick's filing: read, decide, file with the watermarks. */
async function tick(db: TempDb["db"]) {
  const rows = unwrap(await jiraPushSources(db));
  const items = pushesOf(rows);
  unwrap(await fileJiraPushes(db, { items, cursors: rows.advance }));
  return { rows, items };
}

test("a first boot reads no history; the next tick reads what came after", async () => {
  const { db } = await fresh();
  const a = await ticketOf(db, "10001");
  await move(db, a.id, "prioritized");
  await move(db, a.id, "staffed");

  const first = await tick(db);
  expect(first.rows.cursors).toEqual({});
  expect(first.rows.events).toEqual([]);
  expect(first.items).toEqual([]);

  const b = await ticketOf(db, "10002");
  await move(db, b.id, "prioritized");
  await move(db, b.id, "staffed");
  const second = await tick(db);
  expect(second.items.map((p) => [p.issue_key, p.kind, p.moment])).toEqual([
    ["ABC-2", "transition", "started"],
  ]);
  expect(unwrap(await jiraPushesOf(db, b.id))).toEqual([
    expect.objectContaining({
      kind: "transition",
      moment: "started",
      payload_json: '{"status":"In Progress"}',
      state: "pending",
      attempts: 0,
      next_attempt_at: T0,
    }),
  ]);
  expect(unwrap(await jiraPushesOf(db, a.id))).toEqual([]);
  // The watermarks moved: a third tick finds nothing new.
  expect((await tick(db)).items).toEqual([]);
});

test("the same moment filed twice is one push", async () => {
  const { db } = await fresh();
  await tick(db);
  const a = await ticketOf(db, "10001");
  await move(db, a.id, "prioritized");
  await move(db, a.id, "staffed");
  const rows = unwrap(await jiraPushSources(db));
  const items = pushesOf(rows);
  expect(unwrap(await fileJiraPushes(db, { items, cursors: {} }))).toHaveLength(
    1,
  );
  expect(unwrap(await fileJiraPushes(db, { items, cursors: {} }))).toEqual([]);
  // Back and started again: `started` moves an issue once per ticket.
  await move(db, a.id, "prioritized");
  await move(db, a.id, "staffed");
  await tick(db);
  expect(unwrap(await jiraPushesOf(db, a.id))).toHaveLength(1);
});

test("tickets not mirrored, or in a project with no Jira source, are not read", async () => {
  const { db } = await fresh();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(90, { status: "prioritized", workspace_id: "P-A" }),
        ticketRow(91, {
          status: "prioritized",
          origin: "jira",
          origin_ref: "ABC-9",
          origin_fingerprint: jiraFingerprint(HOST, "10009"),
          workspace_id: "P-B",
        }),
      ],
    }),
  );
  await tick(db);
  for (const id of ["ticket-90", "ticket-91"]) await move(db, id, "staffed");
  const { rows } = await tick(db);
  expect(rows.events.map((e) => e.ticket_id)).toEqual([
    "ticket-90",
    "ticket-91",
  ]);
  expect([...rows.tickets.keys()]).toEqual([]);
});

test("a project with no status map and comments off is not read", async () => {
  const { db } = await fresh();
  unwrap(
    await updateRowForTest(db, "workspaces", "P-A", {
      jira_status_map_json: null,
      jira_comment_prs: 0,
    }),
  );
  await tick(db);
  const a = await ticketOf(db, "10001");
  await move(db, a.id, "prioritized");
  await move(db, a.id, "staffed");
  expect((await tick(db)).rows.tickets.size).toBe(0);
});

test("a pull request a delivery opened is read; a pr link no delivery made is not", async () => {
  const { db } = await fresh();
  await tick(db);
  const a = await ticketOf(db, "10001");
  const b = await ticketOf(db, "10002");
  unwrap(
    await seedRows(db, {
      deliveries: [
        {
          id: "D1",
          ticket_id: a.id,
          repo_id: "R",
          branch: "frm/a",
          state: "pr_open",
          pr_url: PR,
          started_at: T0,
        },
      ],
      ticket_links: [
        { ticket_id: a.id, kind: "pr", url: PR, created_at: T0 },
        {
          ticket_id: b.id,
          kind: "pr",
          url: "https://forge.example/x/1",
          created_at: T0,
        },
        { ticket_id: a.id, kind: "doc", url: PR, created_at: T0 },
      ],
    }),
  );
  const { rows, items } = await tick(db);
  expect(rows.links).toEqual([
    { seq: expect.any(Number), ticket_id: a.id, url: PR },
  ]);
  expect(items.map((p) => [p.kind, p.moment, p.dedupe_key])).toEqual([
    ["transition", "in_review", `t:${a.id}:in_review`],
    ["comment", "in_review", `c:${a.id}:pr:${PR}`],
  ]);
});

const transition = (
  ticketId: string,
  moment: NewJiraPush["moment"],
  status: string,
): NewJiraPush => ({
  kind: "transition",
  ticket_id: ticketId,
  workspace_id: "P-A",
  issue_key: "ABC-1",
  moment,
  dedupe_key: `t:${ticketId}:${moment}`,
  payload: { status },
});

test("a later move supersedes the ticket's pending one; a sent one stays", async () => {
  const { db } = await fresh();
  const a = await ticketOf(db, "10001");
  const [started] = unwrap(
    await fileJiraPushes(db, {
      items: [transition(a.id, "started", "In Progress")],
      cursors: {},
    }),
  );
  unwrap(
    await fileJiraPushes(db, {
      items: [transition(a.id, "done", "Done")],
      cursors: {},
    }),
  );
  expect(
    unwrap(await jiraPushesOf(db, a.id)).map((p) => [
      p.id === started,
      p.moment,
      p.state,
      p.last_error,
    ]),
  ).toEqual([
    [true, "started", "skipped", SUPERSEDED],
    [false, "done", "pending", null],
  ]);
});

test("claim, settle and the due list", async () => {
  const { db, clock } = await fresh();
  const a = await ticketOf(db, "10001");
  const [id] = unwrap(
    await fileJiraPushes(db, {
      items: [transition(a.id, "started", "In Progress")],
      cursors: {},
    }),
  );
  if (id === undefined) throw new Error("not filed");
  expect(unwrap(await dueJiraPushes(db, clock.now(), 10))).toEqual([
    expect.objectContaining({
      id,
      issue_key: "ABC-1",
      attempts: 0,
      jira_url: SITE,
      jira_email: "someone@example.com",
    }),
  ]);
  expect(
    unwrap(await claimJiraPush(db, { id, retry_at: T0 + 30_000 })),
  ).toEqual({
    attempts: 1,
  });
  expect(unwrap(await dueJiraPushes(db, clock.now(), 10))).toEqual([]);
  unwrap(
    await settleJiraPush(db, {
      id,
      outcome: {
        state: "pending",
        next_attempt_at: T0 + 30_000,
        error: "x".repeat(900),
      },
    }),
  );
  const [row] = unwrap(await jiraPushesOf(db, a.id));
  expect(row?.last_error).toHaveLength(500);
  expect(unwrap(await dueJiraPushes(db, T0 + 30_000, 10))).toHaveLength(1);
  unwrap(await settleJiraPush(db, { id, outcome: { state: "sent" } }));
  expect(unwrap(await jiraPushesOf(db, a.id))[0]).toMatchObject({
    state: "sent",
    sent_at: T0,
    last_error: null,
  });
  // Settled rows are no longer pending: a second settle or claim is a conflict.
  expect(
    await settleJiraPush(db, { id, outcome: { state: "sent" } }),
  ).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
  expect(await claimJiraPush(db, { id, retry_at: 1 })).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
  expect(await claimJiraPush(db, { id: "nope", retry_at: 1 })).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(
    await fileJiraPushes(db, { items: [{ kind: "x" }] as never, cursors: {} }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
});
