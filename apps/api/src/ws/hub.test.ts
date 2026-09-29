import { FakeClock, err, ok, type FrmError, type Result } from "@bayon/core";
import {
  ServerFrame,
  type EventItem,
  type EventsPage,
  type Fleet,
  type InboxItem,
  type InboxPage,
  type InboxQuery,
  type PulseView,
  type PulsesPage,
  type SpendSummary,
  type TicketEventView,
  type TicketEventsPage,
} from "@bayon/proto";
import { describe, expect, test } from "vitest";
import {
  WsConnection,
  shareSpendSummary,
  type FeedSource,
  type HubSocket,
} from "./hub.js";

const TUNING = {
  tailMs: 200,
  fleetMs: 1_000,
  inboxMs: 500,
  pageLimit: 3,
  highWaterBytes: 1_000,
};
const TOPIC = "session:S1:events";

class FakeSocket implements HubSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: ServerFrame[] = [];
  send(data: string): void {
    this.frames.push(ServerFrame.parse(JSON.parse(data)));
  }
}

const item = (id: number): EventItem => ({
  id,
  kind: "assistant_text",
  ts: id,
  runner_type: "text",
  text: `t${id}`,
  payload: {},
});

const ticketEvent = (id: number): TicketEventView => ({
  id,
  ticket_id: `T${id}`,
  ts: id,
  actor_kind: "operator",
  actor_id: "operator",
  kind: "created",
  from_status: null,
  to_status: "backlog",
  reason: null,
  payload: null,
});

const fleetOf = (sessions: Fleet["sessions"]): Fleet => ({
  paused: false,
  sessions,
  budget: { today_usd: 0, daily_cap_usd: null },
  budgets: [],
  slots: [],
  attention: [],
  disk: [],
  admission: { queued: [], by_reason: {} },
  backup: { last: null, last_ok_at: null },
  runner_updates: [],
});

const quiet = {
  daily_usd: 0,
  baseline_daily_usd: null,
  change_pct: null,
  alarm: false,
  drop: false,
};

const summaryOf = (total_usd: number): SpendSummary => ({
  window: { from: 0, to: 1 },
  total_usd,
  wasted_usd: 0,
  waste_pct: total_usd === 0 ? null : 0,
  burn: {
    today_usd: total_usd,
    month_to_date_usd: total_usd,
    projected_month_usd: total_usd,
  },
  alarm: {
    threshold_pct: 25,
    baseline_days: 30,
    last_day: quiet,
    last_7d: quiet,
    active: false,
    paused: false,
    dropped: false,
  },
});

/** A page after `since` of at most `limit`, as the DB reads pages. */
function pageOf<T extends { readonly id: number }>(
  all: readonly T[],
  since: number,
  limit: number,
) {
  const newer = all.filter((e) => e.id > since);
  const items = newer.slice(0, limit);
  return {
    items,
    next_cursor: items.at(-1)?.id ?? since,
    has_more: newer.length > limit,
  };
}

class FakeSource implements FeedSource {
  events: readonly EventItem[] = [];
  ticketEvents: readonly TicketEventView[] = [];
  fleetValue: Fleet = fleetOf([]);
  eventCalls = 0;
  ticketCalls = 0;
  fleetCalls = 0;
  failWith: FrmError | null = null;

  add(...ids: number[]): void {
    this.events = [...this.events, ...ids.map(item)];
  }
  addTickets(...ids: number[]): void {
    this.ticketEvents = [...this.ticketEvents, ...ids.map(ticketEvent)];
  }
  async eventsSince(q: {
    sessionId: string;
    since: number;
    limit: number;
  }): Promise<Result<EventsPage>> {
    this.eventCalls++;
    if (this.failWith) return err(this.failWith);
    return ok(pageOf(this.events, q.since, q.limit));
  }
  async ticketEventsSince(q: {
    since: number;
    limit: number;
  }): Promise<Result<TicketEventsPage>> {
    this.ticketCalls++;
    if (this.failWith) return err(this.failWith);
    return ok(pageOf(this.ticketEvents, q.since, q.limit));
  }
  async fleet(): Promise<Result<Fleet>> {
    this.fleetCalls++;
    return ok(this.fleetValue);
  }
  spendValue: SpendSummary = summaryOf(0);
  spendCalls = 0;
  async spendSummary(): Promise<Result<SpendSummary>> {
    this.spendCalls++;
    if (this.failWith) return err(this.failWith);
    return ok(this.spendValue);
  }
  pulsesValue: PulsesPage = { items: [] };
  pulsesCalls = 0;
  async recentPulses(): Promise<Result<PulsesPage>> {
    this.pulsesCalls++;
    if (this.failWith) return err(this.failWith);
    return ok(this.pulsesValue);
  }
  inboxValue: InboxPage = inboxOf([]);
  readonly inboxQueries: InboxQuery[] = [];
  async inbox(q: InboxQuery): Promise<Result<InboxPage>> {
    this.inboxQueries.push(q);
    return ok(this.inboxValue);
  }
}

function inboxOf(ids: readonly string[]): InboxPage {
  const request = (id: string): InboxItem => ({
    id,
    status: "open",
    kind: "decision",
    question: `question ${id}`,
    context_md: null,
    options: ["yes", "no"],
    batch_id: null,
    asked_at: 1,
    expires_at: null,
    answer: null,
    answered_by: null,
    answered_at: null,
    ticket: null,
    session: null,
    proposal: null,
  });
  return { items: ids.map(request), next_cursor: null, has_more: false };
}

const pulseOf = (id: string): PulseView => ({
  id,
  agent_id: "A-O",
  trigger: "cron",
  scheduled_at: 1,
  state: "running",
  skip_reason: null,
  session_id: null,
  run_id: null,
  context_pack_path: null,
  context_tokens: null,
  summary_md: null,
  actions: null,
  cost_usd: null,
  started_at: null,
  ended_at: null,
});

/** Runs every queued continuation; the loops then wait on the fake clock. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
  const clock = new FakeClock(1_000_000);
  const socket = new FakeSocket();
  const source = new FakeSource();
  const logged: FrmError[] = [];
  const conn = new WsConnection(socket, {
    source,
    clock,
    tuning: TUNING,
    log: (error) => logged.push(error),
  });
  const send = (frame: unknown) =>
    conn.receive(typeof frame === "string" ? frame : JSON.stringify(frame));
  const eventIds = () =>
    socket.frames.flatMap((f) =>
      f.type === "events" ? f.items.map((i) => i.id) : [],
    );
  return { clock, socket, source, logged, conn, send, eventIds };
}

describe("WsConnection · pulses (M2)", () => {
  test("a snapshot on subscribe, since ignored; then one every fleetMs only when it changed", async () => {
    const { clock, socket, source, send } = setup();
    source.pulsesValue = { items: [pulseOf("P1")] };
    send({ type: "subscribe", topic: "pulses", since: 7 });
    await flush();
    expect(socket.frames).toEqual([
      {
        type: "pulses",
        topic: "pulses",
        cursor: clock.now(),
        data: { items: [pulseOf("P1")] },
      },
    ]);
    await clock.advance(TUNING.fleetMs);
    expect(socket.frames).toHaveLength(1);
    source.pulsesValue = { items: [pulseOf("P2"), pulseOf("P1")] };
    await clock.advance(TUNING.fleetMs);
    expect(socket.frames.at(-1)).toEqual({
      type: "pulses",
      topic: "pulses",
      cursor: clock.now(),
      data: { items: [pulseOf("P2"), pulseOf("P1")] },
    });
    expect(source.pulsesCalls).toBe(3);
  });
});

describe("WsConnection · session events", () => {
  test("replays after since, then tails the DB every tailMs", async () => {
    const { clock, socket, source, send } = setup();
    source.add(1, 2, 3);
    send({ type: "subscribe", topic: TOPIC, since: 1 });
    await flush();
    expect(socket.frames).toEqual([
      { type: "events", topic: TOPIC, cursor: 3, items: [item(2), item(3)] },
    ]);

    source.add(4);
    await clock.advance(TUNING.tailMs - 1);
    expect(socket.frames).toHaveLength(1);
    await clock.advance(1);
    expect(socket.frames.at(-1)).toEqual({
      type: "events",
      topic: TOPIC,
      cursor: 4,
      items: [item(4)],
    });
  });

  test("no since means from the start; a backlog pages back to back", async () => {
    const { socket, source, send, eventIds } = setup();
    source.add(1, 2, 3, 4, 5, 6, 7);
    send({ type: "subscribe", topic: TOPIC });
    await flush();
    expect(socket.frames.map((f) => f.cursor)).toEqual([3, 6, 7]);
    expect(eventIds()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("an idle tail sends nothing", async () => {
    const { clock, socket, source, send } = setup();
    send({ type: "subscribe", topic: TOPIC });
    await flush();
    await clock.advance(TUNING.tailMs * 5);
    expect(socket.frames).toEqual([]);
    expect(source.eventCalls).toBe(6);
  });

  test("a slow client gets resync and its subscription ends", async () => {
    const { clock, socket, source, send, eventIds } = setup();
    source.add(1, 2);
    send({ type: "subscribe", topic: TOPIC });
    await flush();
    socket.bufferedAmount = TUNING.highWaterBytes + 1;
    source.add(3);
    await clock.advance(TUNING.tailMs);
    expect(socket.frames.at(-1)).toEqual({
      type: "resync",
      topic: TOPIC,
      cursor: 2,
    });

    const calls = source.eventCalls;
    source.add(4);
    await clock.advance(TUNING.tailMs * 5);
    expect(source.eventCalls).toBe(calls);

    socket.bufferedAmount = 0;
    send({ type: "subscribe", topic: TOPIC, since: 2 });
    await flush();
    expect(eventIds()).toEqual([1, 2, 3, 4]);
  });

  test("subscribing again restarts from the new since, and the old loop stops", async () => {
    const { clock, source, send, eventIds } = setup();
    source.add(1, 2, 3);
    send({ type: "subscribe", topic: TOPIC });
    await flush();
    send({ type: "subscribe", topic: TOPIC, since: 1 });
    await flush();
    source.add(4);
    await clock.advance(TUNING.tailMs);
    expect(eventIds()).toEqual([1, 2, 3, 2, 3, 4]);
  });

  test("unsubscribe stops the tail; close stops every tail", async () => {
    const { clock, source, send, conn } = setup();
    send({ type: "subscribe", topic: TOPIC });
    send({ type: "subscribe", topic: "session:S2:events" });
    await flush();
    send({ type: "unsubscribe", topic: TOPIC });
    send({ type: "unsubscribe", topic: "never-subscribed" });
    await clock.advance(TUNING.tailMs);
    expect(source.eventCalls).toBe(3);

    conn.close();
    await clock.advance(TUNING.tailMs * 5);
    expect(source.eventCalls).toBe(3);
  });

  test("a retryable read error is logged and retried on the next tick", async () => {
    const { clock, socket, source, logged, send, eventIds } = setup();
    source.add(1);
    source.failWith = { class: "db_busy", message: "busy", retryable: true };
    send({ type: "subscribe", topic: TOPIC });
    await flush();
    expect(logged.map((e) => e.class)).toEqual(["db_busy"]);
    expect(socket.frames).toEqual([]);
    source.failWith = null;
    await clock.advance(TUNING.tailMs);
    expect(eventIds()).toEqual([1]);
  });

  test("a non-retryable read error ends the subscription with an error frame", async () => {
    const { clock, socket, source, send } = setup();
    const error: FrmError = {
      class: "internal",
      message: "bad row",
      retryable: false,
    };
    source.failWith = error;
    send({ type: "subscribe", topic: TOPIC, since: 4 });
    await flush();
    expect(socket.frames).toEqual([
      { type: "error", topic: TOPIC, cursor: 4, error },
    ]);
    await clock.advance(TUNING.tailMs * 3);
    expect(source.eventCalls).toBe(1);
  });

  test("nothing is sent once the socket is no longer open", async () => {
    const { socket, source, send } = setup();
    source.add(1);
    socket.readyState = 2;
    send({ type: "subscribe", topic: TOPIC });
    await flush();
    expect(socket.frames).toEqual([]);
  });
});

describe("WsConnection · tickets (contract 8)", () => {
  test("replays ticket events after since, then tails every tailMs", async () => {
    const { clock, socket, source, send } = setup();
    source.addTickets(1, 2, 3);
    send({ type: "subscribe", topic: "tickets", since: 1 });
    await flush();
    expect(socket.frames).toEqual([
      {
        type: "ticket_events",
        topic: "tickets",
        cursor: 3,
        items: [ticketEvent(2), ticketEvent(3)],
      },
    ]);

    source.addTickets(4);
    await clock.advance(TUNING.tailMs);
    expect(socket.frames.at(-1)).toEqual({
      type: "ticket_events",
      topic: "tickets",
      cursor: 4,
      items: [ticketEvent(4)],
    });
    expect(source.eventCalls).toBe(0);
  });

  test("a backlog pages back to back", async () => {
    const { socket, source, send } = setup();
    source.addTickets(1, 2, 3, 4, 5, 6, 7);
    send({ type: "subscribe", topic: "tickets" });
    await flush();
    expect(socket.frames.map((f) => f.cursor)).toEqual([3, 6, 7]);
  });

  test("a non-retryable read error ends it with an error frame", async () => {
    const { clock, socket, source, send } = setup();
    const error: FrmError = {
      class: "internal",
      message: "bad row",
      retryable: false,
    };
    source.failWith = error;
    send({ type: "subscribe", topic: "tickets", since: 2 });
    await flush();
    expect(socket.frames).toEqual([
      { type: "error", topic: "tickets", cursor: 2, error },
    ]);
    await clock.advance(TUNING.tailMs * 3);
    expect(source.ticketCalls).toBe(1);
  });
});

describe("WsConnection · fleet", () => {
  const row = (turns: number) => ({
    id: "S1",
    agent: "a",
    role: "build",
    run_class: "build",
    state: "running" as const,
    runner_id: "fixture",
    executor_id: "local",
    model_tier: null,
    ticket: null,
    title: null,
    turns,
    cost_usd: 0,
    idle_ms: 0,
    workspace_id: null,
    ticket_key: null,
  });

  test("sends a snapshot at once, then at most one a second, only on change", async () => {
    const { clock, socket, source, send } = setup();
    source.fleetValue = fleetOf([row(0)]);
    send({ type: "subscribe", topic: "fleet", since: 99 });
    await flush();
    expect(socket.frames).toEqual([
      {
        type: "fleet",
        topic: "fleet",
        cursor: 1_000_000,
        data: fleetOf([row(0)]),
      },
    ]);

    for (let turn = 1; turn <= 30; turn++) {
      source.fleetValue = fleetOf([row(turn)]);
      await clock.advance(100);
    }
    const cursors = socket.frames.map((f) => f.cursor);
    expect(cursors).toEqual([1_000_000, 1_001_000, 1_002_000, 1_003_000]);

    await clock.advance(TUNING.fleetMs * 3);
    expect(socket.frames).toHaveLength(4);
  });

  test("a slow client skips snapshots until it drains", async () => {
    const { clock, socket, source, send } = setup();
    send({ type: "subscribe", topic: "fleet" });
    await flush();
    socket.bufferedAmount = TUNING.highWaterBytes + 1;
    source.fleetValue = fleetOf([row(1)]);
    await clock.advance(TUNING.fleetMs);
    expect(socket.frames).toHaveLength(1);
    socket.bufferedAmount = 0;
    await clock.advance(TUNING.fleetMs);
    expect(socket.frames).toHaveLength(2);
    expect(source.fleetCalls).toBe(3);
  });
});

describe("WsConnection · inbox", () => {
  test("inbox sends the open requests on subscribe, then again only when they changed", async () => {
    const { clock, socket, source, send } = setup();
    source.inboxValue = inboxOf(["R1"]);
    send({ type: "subscribe", topic: "inbox", since: 42 });
    await flush();
    expect(socket.frames).toEqual([
      {
        type: "inbox",
        topic: "inbox",
        cursor: 1_000_000,
        data: inboxOf(["R1"]),
      },
    ]);
    expect(source.inboxQueries[0]).toEqual({
      status: "open",
      limit: TUNING.pageLimit,
    });

    await clock.advance(TUNING.inboxMs * 2);
    expect(socket.frames).toHaveLength(1);

    source.inboxValue = inboxOf(["R1", "R2"]); // a new request
    await clock.advance(TUNING.inboxMs);
    source.inboxValue = inboxOf(["R2"]); // R1 answered
    await clock.advance(TUNING.inboxMs);
    expect(socket.frames.map((f) => f.cursor)).toEqual([
      1_000_000, 1_001_500, 1_002_000,
    ]);
    expect(
      socket.frames.map((f) =>
        f.type === "inbox" ? f.data.items.map((i) => i.id) : [],
      ),
    ).toEqual([["R1"], ["R1", "R2"], ["R2"]]);
  });

  test("inbox and spend run side by side, each on its own interval", async () => {
    const { clock, socket, source, send } = setup();
    send({ type: "subscribe", topic: "inbox" });
    send({ type: "subscribe", topic: "spend" });
    await flush();
    source.inboxValue = inboxOf(["R9"]);
    source.spendValue = summaryOf(5);
    await clock.advance(TUNING.inboxMs);
    expect(socket.frames.map((f) => f.type)).toEqual([
      "inbox",
      "spend",
      "inbox",
    ]);
    await clock.advance(TUNING.fleetMs - TUNING.inboxMs);
    expect(socket.frames.map((f) => f.type)).toEqual([
      "inbox",
      "spend",
      "inbox",
      "spend",
    ]);
    expect(source.inboxQueries).toHaveLength(3);
    expect(source.spendCalls).toBe(2);
  });
});

describe("WsConnection · spend (§8.9)", () => {
  test("sends the summary at once, then only when it changes, at most once a second", async () => {
    const { clock, socket, source, send } = setup();
    source.spendValue = summaryOf(1);
    send({ type: "subscribe", topic: "spend", since: 42 });
    await flush();
    expect(socket.frames).toEqual([
      { type: "spend", topic: "spend", cursor: 1_000_000, data: summaryOf(1) },
    ]);

    await clock.advance(TUNING.fleetMs * 3);
    expect(socket.frames).toHaveLength(1);
    source.spendValue = summaryOf(2);
    await clock.advance(TUNING.fleetMs);
    expect(socket.frames.at(-1)).toEqual({
      type: "spend",
      topic: "spend",
      cursor: 1_004_000,
      data: summaryOf(2),
    });
    expect(source.spendCalls).toBe(5);
    expect(source.fleetCalls).toBe(0);
  });

  test("every subscriber shares one summary read per tick", async () => {
    const clock = new FakeClock(1_000_000);
    const source = new FakeSource();
    const shared = shareSpendSummary(source, clock, TUNING.fleetMs);
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    for (const socket of sockets) {
      const conn = new WsConnection(socket, {
        source: shared,
        clock,
        tuning: TUNING,
        log: () => undefined,
      });
      conn.receive(JSON.stringify({ type: "subscribe", topic: "spend" }));
    }
    await flush();
    expect(source.spendCalls).toBe(1);
    expect(sockets.map((s) => s.frames.length)).toEqual([1, 1, 1]);

    source.spendValue = summaryOf(3);
    await clock.advance(TUNING.fleetMs);
    expect(source.spendCalls).toBe(2);
    await clock.advance(TUNING.fleetMs * 2);
    expect(source.spendCalls).toBe(4);
    for (const socket of sockets) {
      expect(socket.frames).toHaveLength(2);
      expect(socket.frames.at(-1)).toEqual({
        type: "spend",
        topic: "spend",
        cursor: 1_001_000,
        data: summaryOf(3),
      });
    }
  });

  test("a subscriber arriving mid-tick gets the tick's summary without a read", async () => {
    const clock = new FakeClock(1_000_000);
    const source = new FakeSource();
    const shared = shareSpendSummary(source, clock, TUNING.fleetMs);
    expect(await shared.spendSummary()).toEqual(ok(summaryOf(0)));
    source.spendValue = summaryOf(9);
    await clock.advance(TUNING.fleetMs - 1);
    expect(await shared.spendSummary()).toEqual(ok(summaryOf(0)));
    expect(source.spendCalls).toBe(1);
    await clock.advance(1);
    expect(await shared.spendSummary()).toEqual(ok(summaryOf(9)));
    expect(source.spendCalls).toBe(2);
    // The rest of the source passes through untouched.
    await shared.fleet();
    expect(source.fleetCalls).toBe(1);
  });

  test("a non-retryable read error ends it with an error frame", async () => {
    const { clock, socket, source, send } = setup();
    const error: FrmError = {
      class: "internal",
      message: "spend.alarm_pct must be a positive number",
      retryable: false,
    };
    source.failWith = error;
    send({ type: "subscribe", topic: "spend" });
    await flush();
    expect(socket.frames).toEqual([
      { type: "error", topic: "spend", cursor: 0, error },
    ]);
    await clock.advance(TUNING.fleetMs * 3);
    expect(source.spendCalls).toBe(1);
  });
});

describe("WsConnection · protocol errors", () => {
  test("an unknown topic is rejected with an error frame", async () => {
    const { socket, source, send } = setup();
    send({ type: "subscribe", topic: "approvals", since: 3 });
    send({ type: "subscribe", topic: "session:S1:pty" });
    await flush();
    expect(socket.frames).toEqual([
      {
        type: "error",
        topic: "approvals",
        cursor: 3,
        error: {
          class: "validation",
          message: "unknown topic: approvals",
          retryable: false,
        },
      },
      {
        type: "error",
        topic: "session:S1:pty",
        cursor: 0,
        error: {
          class: "validation",
          message: "unknown topic: session:S1:pty",
          retryable: false,
        },
      },
    ]);
    expect(source.eventCalls + source.ticketCalls + source.fleetCalls).toBe(0);
  });

  test("the gates topic from a source that serves none is an error frame", async () => {
    const { socket, send } = setup();
    send({ type: "subscribe", topic: "gates" });
    await flush();
    expect(socket.frames).toEqual([
      {
        type: "error",
        topic: "gates",
        cursor: 0,
        error: {
          class: "validation",
          message: "the gates topic is not served here",
          retryable: false,
        },
      },
    ]);
  });

  test("a malformed frame gets an error frame and changes nothing", async () => {
    const { socket, send } = setup();
    send("{nope");
    send({ type: "subscribe" });
    await flush();
    expect(socket.frames.map((f) => [f.type, f.cursor])).toEqual([
      ["error", 0],
      ["error", 0],
    ]);
    expect(
      socket.frames.every(
        (f) => f.type === "error" && f.error.class === "validation",
      ),
    ).toBe(true);
  });
});
