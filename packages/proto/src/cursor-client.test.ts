import { FakeClock, type FrmError } from "@bayon/core";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  CursorClient,
  RECONNECT_DEFAULTS,
  type FeedStatus,
  type WebSocketLike,
} from "./cursor-client.js";
import type { InboxPage } from "./inbox.js";
import type { EventItem, Fleet } from "./rest.js";
import type { SpendSummary } from "./spend.js";
import type { TicketEventView } from "./tickets.js";
import type { ClientFrame } from "./ws.js";

type Listener = (event: { readonly data: unknown }) => void;

/** A WebSocket the test drives by hand: open, receive, drop. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: ClientFrame[] = [];
  readonly #listeners = new Map<string, Listener[]>();

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket not open");
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close(): void {
    this.drop();
  }
  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  open(): void {
    this.readyState = 1;
    this.#emit("open", { data: undefined });
  }
  receive(frame: unknown): void {
    this.receiveRaw(JSON.stringify(frame));
  }
  receiveRaw(data: unknown): void {
    this.#emit("message", { data });
  }
  /** An `error` with no `close`: what Node 22's WebSocket does on a refused or aborted connect. */
  fail(): void {
    this.#emit("error", { data: undefined });
  }
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { data: undefined });
  }
  #emit(type: string, event: { readonly data: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
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
const eventsFrame = (topic: string, ids: number[]) => ({
  type: "events",
  topic,
  cursor: ids.at(-1) ?? 0,
  items: ids.map(item),
});
const TOPIC = "session:S1:events";

function setup() {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const errors: FrmError[] = [];
  const client = new CursorClient({
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    clock,
    onError: (error) => errors.push(error),
  });
  const current = (): FakeSocket => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket yet");
    return socket;
  };
  return { clock, sockets, errors, client, current };
}

function collectEvents(client: CursorClient, sessionId: string, since = 0) {
  const ids: number[] = [];
  const unsubscribe = client.subscribeEvents(
    sessionId,
    (items) => ids.push(...items.map((i) => i.id)),
    since,
  );
  return { ids, unsubscribe };
}

describe("CursorClient", () => {
  test("accepts Node's global WebSocket (and so a browser's)", () => {
    expectTypeOf<WebSocket>().toExtend<WebSocketLike>();
  });

  test("subscribes every topic from its cursor once the socket opens", () => {
    const { client, current } = setup();
    collectEvents(client, "S1", 5);
    client.subscribeFleet(() => {});
    expect(current().sent).toEqual([]);
    current().open();
    expect(current().sent).toEqual([
      { type: "subscribe", topic: TOPIC, since: 5 },
      { type: "subscribe", topic: "fleet" },
    ]);
  });

  test("subscribing on an open socket sends at once", () => {
    const { client, current } = setup();
    current().open();
    collectEvents(client, "S1");
    expect(current().sent).toEqual([
      { type: "subscribe", topic: TOPIC, since: 0 },
    ]);
  });

  test("delivers events in id order and drops ids at or below the cursor", () => {
    const { client, current } = setup();
    const { ids } = collectEvents(client, "S1");
    current().open();
    current().receive(eventsFrame(TOPIC, [1, 2]));
    current().receive(eventsFrame(TOPIC, [2, 3]));
    current().receive(eventsFrame(TOPIC, [1]));
    expect(ids).toEqual([1, 2, 3]);
    expect(client.cursor(TOPIC)).toBe(3);
  });

  test("resubscribes from its last cursor after a reconnect", async () => {
    const { client, clock, sockets, current } = setup();
    const { ids } = collectEvents(client, "S1");
    current().open();
    current().receive(eventsFrame(TOPIC, [1, 2]));
    current().drop();
    expect(sockets).toHaveLength(1);

    await clock.advance(RECONNECT_DEFAULTS.initialMs);
    expect(sockets).toHaveLength(2);
    current().open();
    expect(current().sent).toEqual([
      { type: "subscribe", topic: TOPIC, since: 2 },
    ]);
    current().receive(eventsFrame(TOPIC, [2, 3]));
    expect(ids).toEqual([1, 2, 3]);
  });

  test("an error with no close still reconnects", async () => {
    const { client, clock, sockets, current } = setup();
    collectEvents(client, "S1");
    current().fail();
    await clock.advance(RECONNECT_DEFAULTS.initialMs);
    expect(sockets).toHaveLength(2);
    current().open();
    expect(current().sent).toEqual([
      { type: "subscribe", topic: TOPIC, since: 0 },
    ]);
  });

  test("says when it stops delivering, once per death", async () => {
    const { client, clock, errors, current } = setup();
    const seen: FeedStatus[] = [];
    client.subscribeStatus((status) => seen.push(status));
    expect(client.status).toBe("connecting");

    current().open();
    expect(client.status).toBe("open");
    current().drop();
    expect(client.status).toBe("reconnecting");
    expect(errors.map((e) => e.message)).toEqual([
      "the /ws feed dropped; reconnecting",
    ]);

    // A socket that never opens is the invisible case: it must not raise a second death, and the
    // status must stay `reconnecting` so a reader keeps saying it is not up to date.
    await clock.advance(RECONNECT_DEFAULTS.initialMs);
    current().fail();
    expect(client.status).toBe("reconnecting");
    expect(errors).toHaveLength(1);
    expect(seen).toEqual(["open", "reconnecting"]);
  });

  test("an error followed by a close reconnects once", async () => {
    const { clock, sockets, current } = setup();
    current().open();
    const first = current();
    first.fail();
    first.drop();
    await clock.advance(RECONNECT_DEFAULTS.maxMs);
    expect(sockets).toHaveLength(2);
  });

  test("backs off exponentially up to the cap and resets once connected", async () => {
    const { clock, sockets, current } = setup();
    const { initialMs, maxMs } = RECONNECT_DEFAULTS;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = sockets.length;
      const start = clock.now();
      current().drop();
      while (sockets.length === before) await clock.advance(1);
      delays.push(clock.now() - start);
    }
    expect(delays[0]).toBe(initialMs);
    expect(delays[1]).toBe(initialMs * 2);
    expect(Math.max(...delays)).toBe(maxMs);

    current().open();
    const start = clock.now();
    current().drop();
    const before = sockets.length;
    while (sockets.length === before) await clock.advance(1);
    expect(clock.now() - start).toBe(initialMs);
  });

  test("on resync it resubscribes from its own cursor, not the server's", () => {
    const { client, current } = setup();
    const { ids } = collectEvents(client, "S1");
    current().open();
    current().receive(eventsFrame(TOPIC, [1, 2]));
    current().receive({ type: "resync", topic: TOPIC, cursor: 40 });
    expect(current().sent.at(-1)).toEqual({
      type: "subscribe",
      topic: TOPIC,
      since: 2,
    });
    current().receive(eventsFrame(TOPIC, [2, 3]));
    expect(ids).toEqual([1, 2, 3]);
  });

  test("unsubscribe tells the server and stops delivery", () => {
    const { client, current } = setup();
    const { ids, unsubscribe } = collectEvents(client, "S1");
    current().open();
    current().receive(eventsFrame(TOPIC, [1]));
    unsubscribe();
    unsubscribe();
    current().receive(eventsFrame(TOPIC, [2]));
    expect(ids).toEqual([1]);
    expect(current().sent.filter((f) => f.type === "unsubscribe")).toEqual([
      { type: "unsubscribe", topic: TOPIC },
    ]);
  });

  test("delivers fleet snapshots with their cursor", () => {
    const { client, current } = setup();
    const seen: [Fleet, number][] = [];
    client.subscribeFleet((fleet, cursor) => seen.push([fleet, cursor]));
    current().open();
    const data = {
      paused: false,
      sessions: [],
      budget: { today_usd: 0, daily_cap_usd: null },
      budgets: [],
      slots: [],
      attention: [],
      disk: [],
      admission: { queued: [], by_reason: {} },
      backup: { last: null, last_ok_at: null },
      runner_updates: [],
    };
    current().receive({ type: "fleet", topic: "fleet", cursor: 1_000, data });
    expect(seen).toEqual([[data, 1_000]]);
    expect(client.cursor("fleet")).toBe(1_000);
  });

  test("delivers spend summaries; a reconnect resubscribes without since", async () => {
    const { client, clock, current } = setup();
    const quiet = {
      daily_usd: 0,
      baseline_daily_usd: null,
      change_pct: null,
      alarm: false,
      drop: false,
    };
    const data: SpendSummary = {
      window: { from: 0, to: 2_000 },
      total_usd: 1,
      wasted_usd: 0,
      waste_pct: 0,
      burn: { today_usd: 1, month_to_date_usd: 1, projected_month_usd: 3 },
      alarm: {
        threshold_pct: 25,
        baseline_days: 30,
        last_day: quiet,
        last_7d: quiet,
        active: false,
        paused: false,
        dropped: false,
      },
    };
    const seen: [SpendSummary, number][] = [];
    client.subscribeSpend((summary, cursor) => seen.push([summary, cursor]));
    current().open();
    expect(current().sent).toEqual([{ type: "subscribe", topic: "spend" }]);
    current().receive({ type: "spend", topic: "spend", cursor: 2_000, data });
    current().receive({ type: "fleet", topic: "fleet", cursor: 3_000, data });
    expect(seen).toEqual([[data, 2_000]]);
    expect(client.cursor("spend")).toBe(2_000);

    current().drop();
    await clock.advance(RECONNECT_DEFAULTS.initialMs);
    current().open();
    expect(current().sent).toEqual([{ type: "subscribe", topic: "spend" }]);
  });

  test("delivers inbox snapshots; a reconnect resubscribes without since", async () => {
    const { client, clock, current } = setup();
    const data: InboxPage = { items: [], next_cursor: null, has_more: false };
    const seen: [InboxPage, number][] = [];
    client.subscribeInbox((inbox, cursor) => seen.push([inbox, cursor]));
    current().open();
    expect(current().sent).toEqual([{ type: "subscribe", topic: "inbox" }]);
    current().receive({ type: "inbox", topic: "inbox", cursor: 4_000, data });
    expect(seen).toEqual([[data, 4_000]]);
    expect(client.cursor("inbox")).toBe(4_000);

    current().drop();
    await clock.advance(RECONNECT_DEFAULTS.initialMs);
    current().open();
    expect(current().sent).toEqual([{ type: "subscribe", topic: "inbox" }]);
  });

  test("delivers ticket events in id order, each once, and resubscribes from its cursor", async () => {
    const { client, clock, current } = setup();
    const ticketEvent = (id: number): TicketEventView => ({
      id,
      ticket_id: "T1",
      ts: id,
      actor_kind: "operator",
      actor_id: null,
      kind: "transition",
      from_status: "backlog",
      to_status: "prioritized",
      reason: null,
      payload: {},
    });
    const frame = (ids: number[]) => ({
      type: "ticket_events",
      topic: "tickets",
      cursor: ids.at(-1) ?? 0,
      items: ids.map(ticketEvent),
    });
    const seen: number[] = [];
    client.subscribeTickets((items) => seen.push(...items.map((i) => i.id)), 2);
    current().open();
    expect(current().sent).toEqual([
      { type: "subscribe", topic: "tickets", since: 2 },
    ]);
    current().receive(frame([2, 3, 4]));
    current().receive(frame([4, 5]));
    expect(seen).toEqual([3, 4, 5]);
    expect(client.cursor("tickets")).toBe(5);

    current().drop();
    await clock.advance(RECONNECT_DEFAULTS.initialMs);
    current().open();
    expect(current().sent).toEqual([
      { type: "subscribe", topic: "tickets", since: 5 },
    ]);
  });

  test("a malformed frame is a validation error and changes nothing", () => {
    const { client, errors, current } = setup();
    const { ids } = collectEvents(client, "S1");
    current().open();
    current().receiveRaw("{not json");
    current().receiveRaw(new Uint8Array([1, 2]));
    current().receive({ type: "events", topic: TOPIC, cursor: 1, items: [{}] });
    expect(errors.map((e) => e.class)).toEqual([
      "validation",
      "validation",
      "validation",
    ]);
    expect(ids).toEqual([]);
    expect(client.cursor(TOPIC)).toBe(0);
  });

  test("an error frame is reported; frames for unknown topics are ignored", () => {
    const { client, errors, current } = setup();
    const { ids } = collectEvents(client, "S1");
    current().open();
    const error = { class: "validation", message: "nope", retryable: false };
    current().receive({ type: "error", topic: TOPIC, cursor: 0, error });
    current().receive(eventsFrame("session:OTHER:events", [5]));
    expect(errors).toEqual([error]);
    expect(ids).toEqual([]);
  });

  test("close stops reconnecting and closes the socket", async () => {
    const { client, clock, sockets, current } = setup();
    current().open();
    client.close();
    expect(current().readyState).toBe(3);
    await clock.advance(RECONNECT_DEFAULTS.maxMs * 2);
    expect(sockets).toHaveLength(1);
  });

  test("close during a backoff wait cancels the reconnect", async () => {
    const { client, clock, sockets, current } = setup();
    current().drop();
    client.close();
    await clock.advance(RECONNECT_DEFAULTS.maxMs * 2);
    expect(sockets).toHaveLength(1);
  });
});

// Several screens read one topic at once: the IDE's activity panel beside a ticket
// board, the header's pause switch beside the Fleet. Each listener has its own cursor and its own
// unsubscribe; the server subscription lives while any listener does.
describe("CursorClient fan-out", () => {
  const unsubscribes = (socket: FakeSocket) =>
    socket.sent.filter((f) => f.type === "unsubscribe");

  test("two listeners on one session events topic both get every frame; unsubscribing one leaves the other live", () => {
    const { client, current } = setup();
    current().open();
    const first = collectEvents(client, "S1");
    const second = collectEvents(client, "S1");
    expect(current().sent).toEqual([
      { type: "subscribe", topic: TOPIC, since: 0 },
    ]);
    current().receive(eventsFrame(TOPIC, [1, 2]));
    expect(first.ids).toEqual([1, 2]);
    expect(second.ids).toEqual([1, 2]);

    first.unsubscribe();
    first.unsubscribe();
    expect(unsubscribes(current())).toEqual([]);
    current().receive(eventsFrame(TOPIC, [3]));
    expect(first.ids).toEqual([1, 2]);
    expect(second.ids).toEqual([1, 2, 3]);

    second.unsubscribe();
    expect(unsubscribes(current())).toEqual([
      { type: "unsubscribe", topic: TOPIC },
    ]);
    current().receive(eventsFrame(TOPIC, [4]));
    expect(second.ids).toEqual([1, 2, 3]);
  });

  test("the same function subscribed twice is two listeners, each unsubscribed on its own", () => {
    const { client, current } = setup();
    current().open();
    const seen: number[] = [];
    const on = (items: readonly EventItem[]) =>
      seen.push(...items.map((i) => i.id));
    const one = client.subscribeEvents("S1", on);
    client.subscribeEvents("S1", on);
    one();
    current().receive(eventsFrame(TOPIC, [1]));
    expect(seen).toEqual([1]);
  });

  test("a listener joining below the topic's cursor gets a replay; the others see no id twice", () => {
    const { client, current } = setup();
    current().open();
    const first = collectEvents(client, "S1");
    current().receive(eventsFrame(TOPIC, [1, 2, 3]));
    const late = collectEvents(client, "S1", 1);
    expect(current().sent.at(-1)).toEqual({
      type: "subscribe",
      topic: TOPIC,
      since: 1,
    });
    current().receive(eventsFrame(TOPIC, [2, 3, 4]));
    expect(first.ids).toEqual([1, 2, 3, 4]);
    expect(late.ids).toEqual([2, 3, 4]);
    expect(client.cursor(TOPIC)).toBe(4);

    const sentBefore = current().sent.length;
    collectEvents(client, "S1", 4);
    expect(current().sent).toHaveLength(sentBefore);
  });

  test("a reconnect resubscribes a shared topic once, from its lowest cursor", async () => {
    const { client, clock, current } = setup();
    const low = collectEvents(client, "S1");
    const high = collectEvents(client, "S1", 5);
    current().open();
    expect(current().sent).toEqual([
      { type: "subscribe", topic: TOPIC, since: 0 },
    ]);
    current().receive(eventsFrame(TOPIC, [1, 2, 3]));
    expect(low.ids).toEqual([1, 2, 3]);
    expect(high.ids).toEqual([]);

    current().drop();
    await clock.advance(RECONNECT_DEFAULTS.initialMs);
    current().open();
    expect(current().sent).toEqual([
      { type: "subscribe", topic: TOPIC, since: 3 },
    ]);
    current().receive(eventsFrame(TOPIC, [4, 5, 6]));
    expect(low.ids).toEqual([1, 2, 3, 4, 5, 6]);
    expect(high.ids).toEqual([6]);
  });

  test("a second snapshot listener asks for a fresh snapshot; both get it", () => {
    const { client, current } = setup();
    current().open();
    const seen: string[] = [];
    const leave = client.subscribeInbox(() => seen.push("a"));
    client.subscribeInbox(() => seen.push("b"));
    expect(current().sent).toEqual([
      { type: "subscribe", topic: "inbox" },
      { type: "subscribe", topic: "inbox" },
    ]);
    const data: InboxPage = { items: [], next_cursor: null, has_more: false };
    current().receive({ type: "inbox", topic: "inbox", cursor: 1, data });
    leave();
    current().receive({ type: "inbox", topic: "inbox", cursor: 2, data });
    expect(seen).toEqual(["a", "b", "b"]);
    expect(unsubscribes(current())).toEqual([]);
  });

  test("a listener that throws is reported; the others still get the frame", () => {
    const { client, errors, current } = setup();
    current().open();
    client.subscribeEvents("S1", () => {
      throw new Error("boom");
    });
    const { ids } = collectEvents(client, "S1");
    current().receive(eventsFrame(TOPIC, [1]));
    expect(ids).toEqual([1]);
    expect(errors.map((e) => [e.class, e.message])).toEqual([
      ["internal", `a ${TOPIC} listener threw`],
    ]);
  });
});
