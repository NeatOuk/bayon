import {
  FakeClock,
  armNotification,
  qaHumanNotification,
  type NewNotification,
} from "@bayon/core";
import { afterAll, beforeEach, expect, test } from "vitest";
import { internalsOf, type Db } from "../connection.js";
import { seedRows, seedSpine, tempDb, ticketRow, unwrap } from "../testing.js";
import {
  claimDelivery,
  deferDelivery,
  dueDeliveries,
  insertNotifications,
  listNotifications,
  notifyChannelStats,
  settleDelivery,
  type NotifyFiling,
} from "./notifications.js";
import { notifySources } from "./notify-sources.js";

// The outbox's writers and reads against a temp-file DB: a key filed once whatever
// calls it again, its deliveries with it, the watermarks moved in the same transaction; a delivery
// claimed, deferred and settled only while pending; and the tick's source reads, first boot and
// after.
const T0 = Date.UTC(2026, 8, 22, 12);
const clock = new FakeClock(T0);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

let db: Db;
beforeEach(async () => {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  db = t.db;
  unwrap(await seedSpine(db, 1));
  unwrap(
    await seedRows(db, {
      workspaces: [{ id: "shop", name: "Shop", kind: "single" }],
      tickets: [
        ticketRow(12, { workspace_id: "shop", title: "Add the export" }),
      ],
    }),
  );
});

const TICKET = {
  id: "ticket-12",
  key: "FRM-12",
  num: 12,
  title: "Add the export",
  workspace_id: "shop",
};
const note = (eventId: number): NewNotification =>
  qaHumanNotification({ eventId, ticket: TICKET });

const filing = (
  items: readonly NewNotification[],
  cursors: NotifyFiling["cursors"] = {},
): NotifyFiling => ({
  items: items.map((notification) => ({
    notification,
    deliveries: [
      { channel: "mac", state: "pending", last_error: null },
      { channel: "ntfy", state: "skipped", last_error: "disabled" },
    ],
  })),
  cursors,
});

/** A grouped attention moment on one ticket, as `count` rows of it would read. */
const arm = (count: number): NewNotification =>
  armNotification(
    { why: "unanswered_human", ref: "R1", ticket: TICKET, count },
    T0,
  );

/** A filing whose every delivery is pending: nothing of it has left the process. */
const allPending = (items: readonly NewNotification[]): NotifyFiling => ({
  items: items.map((notification) => ({
    notification,
    deliveries: [
      { channel: "mac", state: "pending", last_error: null },
      { channel: "ntfy", state: "pending", last_error: null },
    ],
  })),
  cursors: {},
});

const count = (table: string): number =>
  (
    unwrap(internalsOf(db))
      .raw.prepare(`SELECT count(*) AS n FROM ${table}`)
      .get() as { n: number }
  ).n;

test("a key is filed once: the same moment again, in the same call or a later one, writes nothing", async () => {
  const first = unwrap(
    await insertNotifications(db, filing([note(1), note(1)])),
  );
  expect(first.created).toHaveLength(1);
  const again = unwrap(
    await insertNotifications(db, filing([note(1), note(2)])),
  );
  expect(again.created).toHaveLength(1);
  expect(count("notifications")).toBe(2);
  // One set of deliveries per notification, however often its key came back.
  expect(count("notification_deliveries")).toBe(4);
  const page = unwrap(await listNotifications(db, { limit: 10 }));
  expect(page.items.map((n) => n.dedupe_key)).toEqual([
    "qa_human:2",
    "qa_human:1",
  ]);
  expect(page.items[0]?.deliveries).toEqual([
    expect.objectContaining({ channel: "mac", state: "pending", attempts: 0 }),
    expect.objectContaining({
      channel: "ntfy",
      state: "skipped",
      last_error: "disabled",
    }),
  ]);
});

test("the watermarks move with the filing, in its transaction, and a refused filing moves none", async () => {
  unwrap(
    await insertNotifications(
      db,
      filing([note(1)], { human_requests: 4, ticket_events: 9 }),
    ),
  );
  expect(unwrap(await notifySources(db)).cursors).toEqual({
    human_requests: 4,
    ticket_events: 9,
  });
  unwrap(await insertNotifications(db, filing([], { human_requests: 7 })));
  expect(unwrap(await notifySources(db)).cursors).toMatchObject({
    human_requests: 7,
    ticket_events: 9,
  });
  const bad = await insertNotifications(db, {
    ...filing([{ ...note(3), link_path: "https://evil.test/" }]),
    cursors: { audit_log: 99 },
  });
  expect(bad.ok).toBe(false);
  expect(unwrap(await notifySources(db)).cursors.audit_log).toBeUndefined();
  expect(
    (await insertNotifications(db, filing([], { human_requests: -1 }))).ok,
  ).toBe(false);
});

test("a delivery is claimed, deferred and settled only while pending", async () => {
  const [id] = unwrap(await insertNotifications(db, filing([note(1)]))).created;
  if (id === undefined) throw new Error("not filed");
  const key = { notification_id: id, channel: "mac" as const };
  expect(unwrap(await dueDeliveries(db, T0, 10))).toEqual([
    expect.objectContaining({
      ...key,
      attempts: 0,
      title: "FRM-12 is ready for your QA",
    }),
  ]);

  unwrap(await deferDelivery(db, { ...key, until: T0 + 60_000 }));
  expect(unwrap(await dueDeliveries(db, T0, 10))).toEqual([]);
  expect(unwrap(await dueDeliveries(db, T0 + 60_000, 10))).toHaveLength(1);

  expect(
    unwrap(await claimDelivery(db, { ...key, retry_at: T0 + 30_000 })),
  ).toEqual({
    attempts: 1,
  });
  unwrap(
    await settleDelivery(db, {
      ...key,
      outcome: {
        state: "pending",
        next_attempt_at: T0 + 30_000,
        error: "x".repeat(900),
      },
    }),
  );
  const retried = unwrap(await listNotifications(db, { limit: 1 })).items[0]
    ?.deliveries[0];
  expect(retried?.last_error).toHaveLength(500);
  expect(retried?.next_attempt_at).toBe(T0 + 30_000);

  unwrap(await claimDelivery(db, { ...key, retry_at: T0 + 150_000 }));
  unwrap(await settleDelivery(db, { ...key, outcome: { state: "sent" } }));
  const sent = unwrap(await listNotifications(db, { limit: 1 })).items[0]
    ?.deliveries[0];
  expect(sent).toMatchObject({
    state: "sent",
    attempts: 2,
    sent_at: T0,
    last_error: null,
  });

  // Settled: nothing claims, defers or settles it again.
  for (const r of [
    await claimDelivery(db, { ...key, retry_at: T0 }),
    await deferDelivery(db, { ...key, until: T0 }),
    await settleDelivery(db, {
      ...key,
      outcome: { state: "failed", error: "e" },
    }),
  ])
    expect(r).toMatchObject({ ok: false, error: { class: "conflict" } });
  expect(
    await claimDelivery(db, {
      notification_id: "NOPE",
      channel: "mac",
      retry_at: T0,
    }),
  ).toMatchObject({ ok: false, error: { class: "not_found" } });
  expect(
    (
      await claimDelivery(db, {
        notification_id: id,
        channel: "pager" as "mac",
        retry_at: T0,
      })
    ).ok,
  ).toBe(false);
});

test("channel stats: the last send, and an error only when it came after it", async () => {
  const [a, b] = unwrap(
    await insertNotifications(db, filing([note(1), note(2)])),
  ).created;
  if (a === undefined || b === undefined) throw new Error("not filed");
  unwrap(
    await claimDelivery(db, {
      notification_id: a,
      channel: "mac",
      retry_at: T0,
    }),
  );
  unwrap(
    await settleDelivery(db, {
      notification_id: a,
      channel: "mac",
      outcome: { state: "failed", error: "osascript timed out" },
    }),
  );
  const failing = unwrap(await notifyChannelStats(db));
  expect(failing.find((s) => s.channel === "mac")).toEqual({
    channel: "mac",
    last_sent_at: null,
    last_error: "osascript timed out",
  });
  await clock.advance(1_000);
  unwrap(
    await claimDelivery(db, {
      notification_id: b,
      channel: "mac",
      retry_at: T0,
    }),
  );
  unwrap(
    await settleDelivery(db, {
      notification_id: b,
      channel: "mac",
      outcome: { state: "sent" },
    }),
  );
  const stats = unwrap(await notifyChannelStats(db));
  expect(stats.map((s) => s.channel)).toEqual([
    "mac",
    "ntfy",
    "webhook",
    "email",
  ]);
  expect(stats[0]).toEqual({
    channel: "mac",
    last_sent_at: T0 + 1_000,
    last_error: null,
  });
});

test("the outbox pages newest first by its cursor", async () => {
  unwrap(await insertNotifications(db, filing([1, 2, 3, 4, 5].map(note))));
  const one = unwrap(await listNotifications(db, { limit: 2 }));
  expect(one.items.map((n) => n.dedupe_key)).toEqual([
    "qa_human:5",
    "qa_human:4",
  ]);
  expect(one.next).not.toBeNull();
  const two = unwrap(
    await listNotifications(db, { before: one.next ?? 0, limit: 2 }),
  );
  expect(two.items.map((n) => n.dedupe_key)).toEqual([
    "qa_human:3",
    "qa_human:2",
  ]);
  const three = unwrap(
    await listNotifications(db, { before: two.next ?? 0, limit: 2 }),
  );
  expect(three.items.map((n) => n.dedupe_key)).toEqual(["qa_human:1"]);
  expect(three.next).toBeNull();
});

test("sources: a first boot reads no history and starts each watermark at the newest row", async () => {
  unwrap(
    await seedRows(db, {
      human_requests: [
        {
          id: "R1",
          kind: "question",
          question: "old?",
          asked_at: 1,
          ticket_id: "ticket-12",
        },
      ],
      ticket_events: [
        {
          ticket_id: "ticket-12",
          ts: 1,
          actor_kind: "operator",
          kind: "transition",
          from_status: "code_review",
          to_status: "qa_human",
        },
      ],
      audit_log: [
        {
          ts: 1,
          actor: "supervisor",
          action: "supervisor.block_ticket",
          target_id: "ticket-12",
        },
      ],
    }),
  );
  const boot = unwrap(await notifySources(db));
  expect(boot.cursors).toEqual({});
  expect([boot.requests, boot.qaHuman, boot.blocks]).toEqual([[], [], []]);
  expect(boot.advance.human_requests).toBeGreaterThan(0);
  expect(boot.advance.ticket_events).toBeGreaterThan(0);
  expect(boot.advance.audit_log).toBeGreaterThan(0);

  unwrap(await insertNotifications(db, { items: [], cursors: boot.advance }));
  unwrap(
    await seedRows(db, {
      human_requests: [
        {
          id: "R2",
          kind: "decision",
          question: "new?",
          asked_at: 2,
          ticket_id: "ticket-12",
        },
        // Answered before the tick saw it: not notified.
        {
          id: "R3",
          kind: "decision",
          question: "gone?",
          asked_at: 2,
          status: "answered",
        },
      ],
      ticket_events: [
        // A ticket already in qa_human, updated again: no new entry into it.
        {
          ticket_id: "ticket-12",
          ts: 2,
          actor_kind: "operator",
          kind: "transition",
          from_status: "qa_human",
          to_status: "qa_human",
        },
        {
          ticket_id: "ticket-12",
          ts: 3,
          actor_kind: "operator",
          kind: "transition",
          from_status: "code_review",
          to_status: "qa_human",
        },
      ],
      audit_log: [
        {
          ts: 2,
          actor: "supervisor",
          action: "supervisor.block_ticket",
          target_kind: "ticket",
          target_id: "ticket-12",
          payload_json: JSON.stringify({
            from: "building",
            blocked_reason: "3 failed runs",
            human_request_id: "R2",
          }),
        },
        { ts: 2, actor: "operator", action: "settings.put" },
      ],
    }),
  );
  const next = unwrap(await notifySources(db));
  expect(
    next.requests.map((r) => [r.id, r.ticket?.key, r.workspace_id]),
  ).toEqual([["R2", "FRM-12", "shop"]]);
  expect(next.qaHuman).toHaveLength(1);
  expect(next.blocks).toEqual([
    {
      auditId: expect.any(Number),
      ticket: expect.objectContaining({ key: "FRM-12" }),
      reason: "3 failed runs",
      requestId: "R2",
      question: "new?",
    },
  ]);
  expect(next.advance.audit_log).toBeGreaterThan(boot.advance.audit_log);
});

test("sources: a failed Jira sync notifies only after one that did not fail", async () => {
  unwrap(
    await insertNotifications(db, { items: [], cursors: { audit_log: 0 } }),
  );
  const sync = (ok: boolean, id: number) => ({
    id,
    ts: id,
    actor: "operator",
    action: "jira.sync",
    target_kind: "project",
    target_id: "shop",
    payload_json: JSON.stringify(
      ok
        ? { ok: true }
        : {
            ok: false,
            error: { class: "runner_error", message: `HTTP 503 #${id}` },
          },
    ),
  });
  unwrap(
    await seedRows(db, {
      audit_log: [
        sync(false, 1),
        sync(false, 2),
        sync(true, 3),
        sync(false, 4),
        sync(false, 5),
      ],
    }),
  );
  const got = unwrap(await notifySources(db)).jiraFailures;
  // The first ever failure, and the first after the success: never the repeats.
  expect(got.map((j) => [j.auditId, j.workspaceName, j.message])).toEqual([
    [1, "Shop", "HTTP 503 #1"],
    [4, "Shop", "HTTP 503 #4"],
  ]);
});

test("sources: the human-only arms standing now, the budget warnings apart", async () => {
  unwrap(
    await seedRows(db, {
      backups: [
        {
          id: "K1",
          started_at: 1,
          ended_at: 2,
          outcome: "failed",
          error: "disk",
        },
      ],
      budgets: [
        {
          id: "B1",
          scope: "fleet",
          period: "day",
          cap_usd: 0,
          warn_pct: 50,
          updated_at: 1,
        },
      ],
    }),
  );
  const rows = unwrap(await notifySources(db));
  expect(rows.arms).toEqual([
    { why: "backup_failed", ref: "K1", ticket: null },
  ]);
  expect(rows.budgets).toEqual([
    {
      id: "B1",
      scope: "fleet",
      agent: null,
      period: "day",
      cap_usd: 0,
      cap_tokens: null,
      warn_pct: 50,
    },
  ]);
});

test("a grouped moment that grows while nothing has gone out is corrected in place", async () => {
  const filed = unwrap(await insertNotifications(db, allPending([arm(1)])));
  expect(filed.created).toHaveLength(1);
  expect(filed.refreshed).toEqual([]);

  const grown = unwrap(await insertNotifications(db, allPending([arm(3)])));
  expect(grown.created).toEqual([]);
  expect(grown.refreshed).toEqual(filed.created);

  const page = unwrap(await listNotifications(db, { limit: 10 }));
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.title).toBe(
    "3 questions have waited over a day on FRM-12",
  );
  // The key never moved, so nobody was notified a second time.
  expect(page.items[0]?.dedupe_key).toBe(arm(1).dedupe_key);
  // And the deliveries are neither duplicated nor put back to the start.
  expect(count("notification_deliveries")).toBe(2);
  expect(
    page.items[0]?.deliveries.map((d) => [d.channel, d.state, d.attempts]),
  ).toEqual([
    ["mac", "pending", 0],
    ["ntfy", "pending", 0],
  ]);
});

test("once a delivery has gone out, the row keeps the text that was sent", async () => {
  const [id] = unwrap(
    await insertNotifications(db, allPending([arm(1)])),
  ).created;
  if (id === undefined) throw new Error("not filed");
  const key = { notification_id: id, channel: "mac" as const };
  unwrap(await claimDelivery(db, { ...key, retry_at: T0 + 30_000 }));
  unwrap(await settleDelivery(db, { ...key, outcome: { state: "sent" } }));

  const grown = unwrap(await insertNotifications(db, allPending([arm(3)])));
  expect(grown).toEqual({ created: [], refreshed: [] });
  const page = unwrap(await listNotifications(db, { limit: 10 }));
  expect(page.items[0]?.title).toBe(
    "A question has waited over a day on FRM-12",
  );
  // The delivery that went is untouched by the second filing.
  expect(page.items[0]?.deliveries).toContainEqual(
    expect.objectContaining({ channel: "mac", state: "sent", attempts: 1 }),
  );
});

test("a channel that is off does not stop the correction: skipped never left the process", async () => {
  // filing() marks mac pending and ntfy skipped, as a channel that is off is marked at filing.
  const filed = unwrap(await insertNotifications(db, filing([arm(1)])));
  const grown = unwrap(await insertNotifications(db, filing([arm(3)])));
  expect(grown.created).toEqual([]);
  expect(grown.refreshed).toEqual(filed.created);
  expect(
    unwrap(await listNotifications(db, { limit: 10 })).items[0]?.title,
  ).toBe("3 questions have waited over a day on FRM-12");
});

test("a delivery that failed stops the correction as a sent one does", async () => {
  const [id] = unwrap(
    await insertNotifications(db, allPending([arm(1)])),
  ).created;
  if (id === undefined) throw new Error("not filed");
  const key = { notification_id: id, channel: "mac" as const };
  unwrap(await claimDelivery(db, { ...key, retry_at: T0 + 30_000 }));
  unwrap(
    await settleDelivery(db, {
      ...key,
      outcome: { state: "failed", error: "ntfy answered HTTP 400" },
    }),
  );
  const grown = unwrap(await insertNotifications(db, allPending([arm(3)])));
  expect(grown).toEqual({ created: [], refreshed: [] });
  expect(
    unwrap(await listNotifications(db, { limit: 10 })).items[0]?.title,
  ).toBe("A question has waited over a day on FRM-12");
});

test("the same moment twice in one call files once and corrects nothing", async () => {
  const filed = unwrap(
    await insertNotifications(db, allPending([arm(1), arm(1)])),
  );
  expect(filed.created).toHaveLength(1);
  expect(filed.refreshed).toEqual([]);
});
