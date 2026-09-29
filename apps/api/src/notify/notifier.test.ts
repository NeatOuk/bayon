import {
  FakeClock,
  NOTIFY_CHANNELS,
  err,
  ok,
  quietEndsAt,
  utcDay,
  type FrmError,
  type NotifyChannel,
  type Result,
} from "@bayon/core";
import { listNotifications, type Db } from "@bayon/db";
import { recordRunnerUpdate } from "@bayon/db/testing";
import {
  seedRows,
  seedSpine,
  sqlClockFollowsDate,
  tempDb,
  ticketRow,
  unwrap,
  type SeedRows,
} from "@bayon/db/testing";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChannelSet, Outbound } from "./channels/index.js";
import { Notifier } from "./notifier.js";

// The notifier on a FakeClock over a temp-file DB, with stub channels that record what
// they are asked to send: each trigger files exactly one notification, a restart files and sends
// nothing twice, a first boot back-fills no history, quiet hours hold and then release, the backoff
// runs to `failed`, and a channel that is off is skipped and never sent.
//
// Every test runs with the system date a year past today, for JavaScript (vi.setSystemTime) and for
// SQLite (sqlClockFollowsDate): only the FakeClock may move what the notifier sees. These tests broke
// the day the real date passed T0 + 24 h, while the attention view aged its rows on SQLite's own
// clock; a read that slips back to the real clock fails here, today.

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);
const DAY = 86_400_000;
/** The system date every test runs at: a year past today. */
const SYSTEM_NOW = Date.now() + 365 * DAY;
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

interface Sent {
  readonly channel: NotifyChannel;
  readonly o: Outbound;
}

let clock: FakeClock;
let db: Db;
let sent: Sent[];
/** Per channel, what its next sends answer; ok once empty. */
let answers: Record<NotifyChannel, Result<void>[]>;
let lines: string[];

function stubChannels(): ChannelSet {
  const one = (channel: NotifyChannel) => ({
    channel,
    configured: () => Promise.resolve(true),
    send: (o: Outbound) => {
      sent.push({ channel, o });
      return Promise.resolve(answers[channel].shift() ?? ok(undefined));
    },
  });
  return {
    mac: one("mac"),
    ntfy: one("ntfy"),
    webhook: one("webhook"),
    email: one("email"),
  };
}

const notifier = () =>
  new Notifier({
    db,
    clock,
    channels: stubChannels(),
    logger: { warn: (m) => lines.push(m), error: (m) => lines.push(m) },
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SYSTEM_NOW);
  clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  db = t.db;
  unwrap(sqlClockFollowsDate(db));
  sent = [];
  lines = [];
  answers = { mac: [], ntfy: [], webhook: [], email: [] };
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

afterEach(() => {
  vi.useRealTimers();
});

const setting = (key: string, value: unknown) => ({
  key,
  value_json: JSON.stringify(value),
  updated_at: 0,
});
const settings = (...s: ReturnType<typeof setting>[]) =>
  seedRows(db, { settings: s });
const enable = (...channels: NotifyChannel[]) =>
  settings(...channels.map((c) => setting(`notify.${c}.enabled`, 1)));

const question = (
  id: string,
  o: Partial<NonNullable<SeedRows["human_requests"]>[number]> = {},
) => ({
  id,
  session_id: "session-fixture",
  ticket_id: "ticket-12",
  kind: "decision",
  question: `question ${id}?`,
  asked_at: clock.now(),
  ...o,
});

const outbox = async () =>
  unwrap(await listNotifications(db, { limit: 100 })).items;
const keys = async () => (await outbox()).map((n) => n.dedupe_key).toSorted();
const deliveryOf = async (key: string, channel: NotifyChannel) =>
  (await outbox())
    .find((n) => n.dedupe_key === key)
    ?.deliveries.find((d) => d.channel === channel);

const failure = (retryable: boolean): Result<void> =>
  err({
    class: "runner_error",
    message: "ntfy answered HTTP 503",
    retryable,
  } satisfies FrmError);

test("each trigger files exactly one notification, and a second tick files none", async () => {
  const n = notifier();
  await n.tick(); // first boot: the watermarks start here
  expect(await keys()).toEqual([]);
  unwrap(
    await seedRows(db, {
      human_requests: [
        question("R-Q"),
        question("R-P", {
          kind: "staff_approval",
          question: "Staff FRM-12 as builder?",
        }),
        question("R-BLOCK", { kind: "circuit_breaker", session_id: null }),
      ],
      ticket_events: [
        {
          ticket_id: "ticket-12",
          ts: clock.now(),
          actor_kind: "operator",
          kind: "transition",
          from_status: "code_review",
          to_status: "qa_human",
        },
      ],
      audit_log: [
        {
          ts: clock.now(),
          actor: "supervisor",
          action: "supervisor.block_ticket",
          target_kind: "ticket",
          target_id: "ticket-12",
          payload_json: JSON.stringify({
            blocked_reason: "3 failed runs",
            human_request_id: "R-BLOCK",
          }),
        },
        {
          ts: clock.now(),
          actor: "operator",
          action: "jira.sync",
          target_kind: "project",
          target_id: "shop",
          payload_json: JSON.stringify({ ok: true }),
        },
        {
          ts: clock.now(),
          actor: "operator",
          action: "jira.sync",
          target_kind: "project",
          target_id: "shop",
          payload_json: JSON.stringify({
            ok: false,
            error: { message: "HTTP 503" },
          }),
        },
      ],
      budgets: [
        {
          id: "B1",
          scope: "fleet",
          period: "day",
          cap_usd: 0,
          warn_pct: 50,
          updated_at: 0,
        },
      ],
      backups: [
        {
          id: "K1",
          started_at: 0,
          ended_at: 1,
          outcome: "failed",
          error: "disk",
        },
      ],
    }),
  );
  await n.tick();
  const day = utcDay(T0);
  const filed = await outbox();
  expect(
    filed
      .map((x) => [x.event_kind, x.dedupe_key.replace(/:\d+$/, ":<id>")])
      .toSorted(),
  ).toEqual([
    ["attention", `attention:backup_failed:K1:-:${day}`],
    ["budget_warn", `budget_warn:B1:${day}`],
    ["jira_sync_failed", "jira_sync:<id>"],
    ["qa_human", "qa_human:<id>"],
    ["question", "request:R-Q"],
    ["staff_proposal", "proposal:R-P"],
    // The block's own request is folded into it: one block, one notification.
    ["ticket_blocked", "blocked:<id>"],
  ]);
  expect(filed.find((x) => x.event_kind === "question")).toMatchObject({
    title: "fixture asked on FRM-12",
    body: "question R-Q?",
    link_path: "#/p/shop/inbox?ticket=12",
    workspace_id: "shop",
    ticket_id: "ticket-12",
  });
  expect(filed.find((x) => x.event_kind === "ticket_blocked")?.body).toBe(
    "3 failed runs\nquestion R-BLOCK?",
  );
  // Every channel is off by default: every delivery row is skipped, and nothing was sent.
  expect(filed.flatMap((x) => x.deliveries.map((d) => d.state))).toEqual(
    Array.from({ length: 7 * NOTIFY_CHANNELS.length }, () => "skipped"),
  );
  expect(sent).toEqual([]);

  // The arms still stand: the next tick finds them again and files nothing for them. The new
  // question beside them is still filed, so a standing row never blocks the filing it rides in.
  unwrap(await seedRows(db, { human_requests: [question("R-NEXT")] }));
  await n.tick();
  expect(await outbox()).toHaveLength(8);
  expect(await keys()).toContain("request:R-NEXT");
  expect(lines).toEqual([]);
});

test("an open runner update files once, and stands like an arm: no key, no day, never a repeat", async () => {
  const n = notifier();
  await n.tick(); // first boot: the watermarks start here
  unwrap(
    await recordRunnerUpdate(db, {
      runner_id: "fixture",
      current: "0.3.283",
      latest: "0.3.290",
      newer: true,
    }),
  );
  await n.tick();
  expect(await keys()).toEqual(["runner_update:fixture:0.3.290"]);
  const filed = (await outbox()).find(
    (n2) => n2.dedupe_key === "runner_update:fixture:0.3.290",
  );
  expect(filed).toMatchObject({
    event_kind: "attention",
    title: "fixture 0.3.283 → 0.3.290 available",
    link_path: "#/runners",
  });

  // Still open on the next tick: it stands, but files nothing a second time.
  await n.tick();
  expect(await outbox()).toHaveLength(1);
});

test("a restart files nothing twice and sends nothing twice", async () => {
  unwrap(await enable("mac"));
  await notifier().tick();
  unwrap(await seedRows(db, { human_requests: [question("R1")] }));
  await notifier().tick();
  expect(sent.map((s) => [s.channel, s.o.title])).toEqual([
    ["mac", "fixture asked on FRM-12"],
  ]);
  // A new notifier over the same DB: the watermark and the outbox are the whole of its state.
  const restarted = notifier();
  await restarted.tick();
  await clock.advance(60_000);
  await restarted.tick();
  expect(await keys()).toEqual(["request:R1"]);
  expect(sent).toHaveLength(1);
  expect(await deliveryOf("request:R1", "mac")).toMatchObject({
    state: "sent",
    attempts: 1,
  });
});

test("an open question is a day unanswered by the injected clock, never by the system date", async () => {
  unwrap(await enable("mac"));
  const n = notifier();
  await n.tick();
  unwrap(await seedRows(db, { human_requests: [question("R1")] }));
  await n.tick();
  // The system date is a year past T0: a read of the real clock would call it unanswered now.
  expect(Date.now() - T0).toBeGreaterThan(300 * DAY);
  await clock.advance(DAY);
  await n.tick();
  expect(await keys()).toEqual(["request:R1"]);
  await clock.advance(1);
  await n.tick();
  expect(await keys()).toEqual([
    `attention:unanswered_human:-:ticket-12:${utcDay(clock.now())}`,
    "request:R1",
  ]);
  expect(sent.map((s) => s.o.title)).toEqual([
    "fixture asked on FRM-12",
    "A question has waited over a day on FRM-12",
  ]);
});

test("a first boot back-fills no history: old questions, transitions, blocks and syncs stay unsaid", async () => {
  unwrap(await enable("mac"));
  unwrap(
    await seedRows(db, {
      human_requests: [question("OLD")],
      ticket_events: [
        {
          ticket_id: "ticket-12",
          ts: 0,
          actor_kind: "operator",
          kind: "transition",
          to_status: "qa_human",
        },
      ],
      audit_log: [
        {
          ts: 0,
          actor: "supervisor",
          action: "supervisor.block_ticket",
          target_id: "ticket-12",
        },
        {
          ts: 0,
          actor: "operator",
          action: "jira.sync",
          target_id: "shop",
          payload_json: '{"ok":false}',
        },
      ],
    }),
  );
  await notifier().tick();
  expect(await keys()).toEqual([]);
  expect(sent).toEqual([]);
  unwrap(await seedRows(db, { human_requests: [question("NEW")] }));
  await notifier().tick();
  expect(await keys()).toEqual(["request:NEW"]);
});

test("quiet hours hold ntfy until they end, the Mac's goes at once, and the held one then goes", async () => {
  const hour = new Date(T0).getHours();
  const quiet = { start: hour, end: (hour + 2) % 24 };
  unwrap(await enable("mac", "ntfy"));
  unwrap(
    await settings(
      setting("notify.quiet_start_hour", quiet.start),
      setting("notify.quiet_end_hour", quiet.end),
    ),
  );
  const n = notifier();
  await n.tick();
  unwrap(await seedRows(db, { human_requests: [question("R1")] }));
  await n.tick();
  expect(sent.map((s) => s.channel)).toEqual(["mac"]);
  const held = await deliveryOf("request:R1", "ntfy");
  expect(held).toMatchObject({ state: "pending", attempts: 0 });
  expect(held?.next_attempt_at).toBe(quietEndsAt(T0, quiet));
  // Still quiet a minute before the end: nothing more goes, and no attempt is spent.
  await clock.advance(quietEndsAt(T0, quiet) - T0 - 60_000);
  await n.tick();
  expect(sent.map((s) => s.channel)).toEqual(["mac"]);
  await clock.advance(60_000);
  await n.tick();
  expect(sent.map((s) => s.channel)).toEqual(["mac", "ntfy"]);
  expect(await deliveryOf("request:R1", "ntfy")).toMatchObject({
    state: "sent",
    attempts: 1,
  });
});

test("a retryable failure backs off 30 s, 2 m, 10 m, 1 h and 6 h, then is failed and never sent again", async () => {
  unwrap(await enable("ntfy"));
  answers.ntfy = Array.from({ length: 10 }, () => failure(true));
  const n = notifier();
  await n.tick();
  unwrap(await seedRows(db, { human_requests: [question("R1")] }));
  await n.tick();
  const waits = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
  for (const [i, wait] of waits.entries()) {
    const d = await deliveryOf("request:R1", "ntfy");
    expect([
      i,
      d?.state,
      d?.attempts,
      (d?.next_attempt_at ?? 0) - clock.now(),
    ]).toEqual([i, "pending", i + 1, wait]);
    await clock.advance(wait - 1);
    await n.tick(); // one millisecond early: not due
    expect(sent).toHaveLength(i + 1);
    await clock.advance(1);
    await n.tick();
  }
  expect(sent).toHaveLength(6);
  expect(await deliveryOf("request:R1", "ntfy")).toMatchObject({
    state: "failed",
    attempts: 6,
    last_error: "ntfy answered HTTP 503",
  });
  // A day on, R1's failed delivery is never tried again. The question has now waited over a day on
  // the injected clock, so its attention is filed and tried once, on its own key.
  await clock.advance(86_400_000);
  await n.tick();
  expect(sent.map((s) => s.o.title)).toEqual([
    ...Array.from({ length: 6 }, () => "fixture asked on FRM-12"),
    "A question has waited over a day on FRM-12",
  ]);
  expect(await keys()).toEqual([
    `attention:unanswered_human:-:ticket-12:${utcDay(clock.now())}`,
    "request:R1",
  ]);
  expect(await deliveryOf("request:R1", "ntfy")).toMatchObject({
    state: "failed",
    attempts: 6,
  });
  expect(lines.some((l) => l.includes("failed: ntfy answered HTTP 503"))).toBe(
    true,
  );
});

test("a refusal that is not retryable is failed at once; a channel not configured is skipped", async () => {
  unwrap(await enable("ntfy", "webhook"));
  answers.ntfy = [failure(false)];
  answers.webhook = [
    err({
      class: "not_found",
      message: "NOTIFY_WEBHOOK_URL is not in the host secret store",
      retryable: false,
    }),
  ];
  const n = notifier();
  await n.tick();
  unwrap(await seedRows(db, { human_requests: [question("R1")] }));
  await n.tick();
  expect(await deliveryOf("request:R1", "ntfy")).toMatchObject({
    state: "failed",
    attempts: 1,
  });
  expect(await deliveryOf("request:R1", "webhook")).toMatchObject({
    state: "skipped",
    last_error: "NOTIFY_WEBHOOK_URL is not in the host secret store",
  });
  await clock.advance(86_400_000);
  await n.tick();
  expect(sent).toHaveLength(2);
});

test("a channel that is off, or not subscribed to the kind, is skipped and never sent", async () => {
  unwrap(await enable("mac", "email"));
  // email takes staffing proposals only (bit 2).
  unwrap(await settings(setting("notify.email.events", 2)));
  const n = notifier();
  await n.tick();
  unwrap(await seedRows(db, { human_requests: [question("R1")] }));
  await n.tick();
  expect(sent.map((s) => s.channel)).toEqual(["mac"]);
  expect(await deliveryOf("request:R1", "ntfy")).toMatchObject({
    state: "skipped",
    last_error: "disabled",
  });
  expect(await deliveryOf("request:R1", "email")).toMatchObject({
    state: "skipped",
    last_error: "not subscribed",
  });

  // Filed while on, switched off before it went (held by the backoff): skipped at delivery.
  answers.mac = [failure(true)];
  unwrap(await seedRows(db, { human_requests: [question("R2")] }));
  await n.tick();
  unwrap(await settings(setting("notify.mac.enabled", 0)));
  await clock.advance(30_000);
  await n.tick();
  expect(await deliveryOf("request:R2", "mac")).toMatchObject({
    state: "skipped",
    attempts: 1,
  });
  expect(sent).toHaveLength(2);
});

test("the link joins notify.base_url's origin to the hash path; without it there is none", async () => {
  unwrap(await enable("mac"));
  const n = notifier();
  await n.tick();
  unwrap(await seedRows(db, { human_requests: [question("R1")] }));
  await n.tick();
  expect(sent[0]?.o.link).toBeNull();
  unwrap(await settings(setting("notify.base_url", "https://bayon.lan:5173")));
  unwrap(await seedRows(db, { human_requests: [question("R2")] }));
  await n.tick();
  expect(sent[1]?.o.link).toBe(
    "https://bayon.lan:5173/#/p/shop/inbox?ticket=12",
  );
});

test("an unreadable setting is read as its default (off) and said once, not every tick", async () => {
  unwrap(await settings(setting("notify.mac.enabled", 7)));
  const n = notifier();
  await n.tick();
  await n.tick();
  expect(lines.filter((l) => l.includes("notify.mac.enabled"))).toHaveLength(1);
});

/** Lets every continuation the loop has queued run: no timer, no wall-clock wait. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("the loop ticks every notify.poll_ms on the injected clock, and stops", async () => {
  unwrap(await enable("mac"));
  unwrap(await settings(setting("notify.poll_ms", 5_000)));
  const n = notifier();
  n.start();
  n.start(); // a second start is the same loop
  await settle();
  await clock.advance(5_000); // the first tick: a first boot, the watermarks start here
  await settle();
  unwrap(await seedRows(db, { human_requests: [question("R1")] }));
  await clock.advance(4_999);
  await settle();
  expect(sent).toHaveLength(0);
  await clock.advance(1);
  await settle();
  expect(sent.map((s) => s.channel)).toEqual(["mac"]);
  await n.stop();
  await clock.advance(60_000);
  await settle();
  expect(sent).toHaveLength(1);
});
