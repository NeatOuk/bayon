import type { Clock, FrmError } from "@bayon/core";
import { z } from "zod";
import type { GatesPage } from "./gates.js";
import type { InboxPage } from "./inbox.js";
import type { PulsesPage } from "./pulses.js";
import type { EventItem, Fleet } from "./rest.js";
import type { SpendSummary } from "./spend.js";
import type { TicketEventView } from "./tickets.js";
import {
  FLEET_TOPIC,
  GATES_TOPIC,
  INBOX_TOPIC,
  PULSES_TOPIC,
  SPEND_TOPIC,
  ServerFrame,
  TICKETS_TOPIC,
  sessionEventsTopic,
  type ClientFrame,
  type EventsFrame,
  type FleetFrame,
  type GatesFrame,
  type InboxFrame,
  type PulsesFrame,
  type SpendFrame,
  type TicketEventsFrame,
  type Topic,
} from "./ws.js";

/**
 * The part of a WebSocket the client uses. Node 22's global WebSocket and a browser's both fit, so
 * `connect: () => new WebSocket(url)` works in either; Node may pass `{ headers }` for the bearer.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  addEventListener(
    type: "open" | "close" | "error",
    listener: () => void,
  ): void;
}

export const RECONNECT_DEFAULTS = { initialMs: 250, maxMs: 5_000 } as const;

/**
 * Whether the feed is delivering. `connecting` is the first attempt, `reconnecting` every attempt
 * after a socket died — a reader showing nothing is only trustworthy while this is `open`.
 */
export type FeedStatus = "connecting" | "open" | "reconnecting";

export interface CursorClientOptions {
  readonly connect: () => WebSocketLike;
  /** Drives the reconnect backoff. */
  readonly clock: Clock;
  readonly reconnect?: { readonly initialMs: number; readonly maxMs: number };
  /** Malformed frames, server `error` frames and failed connects. */
  readonly onError: (error: FrmError) => void;
}

export type OnEvents = (items: readonly EventItem[], cursor: number) => void;
export type OnFleet = (fleet: Fleet, cursor: number) => void;
export type OnSpend = (spend: SpendSummary, cursor: number) => void;
export type OnPulses = (pulses: PulsesPage, cursor: number) => void;
export type OnInbox = (inbox: InboxPage, cursor: number) => void;
export type OnGates = (gates: GatesPage, cursor: number) => void;
export type OnTicketEvents = (
  items: readonly TicketEventView[],
  cursor: number,
) => void;

type Subscription =
  | { readonly kind: "events"; readonly cursor: number; readonly on: OnEvents }
  | { readonly kind: "fleet"; readonly cursor: number; readonly on: OnFleet }
  | { readonly kind: "spend"; readonly cursor: number; readonly on: OnSpend }
  | { readonly kind: "pulses"; readonly cursor: number; readonly on: OnPulses }
  | { readonly kind: "inbox"; readonly cursor: number; readonly on: OnInbox }
  | { readonly kind: "gates"; readonly cursor: number; readonly on: OnGates }
  | {
      readonly kind: "tickets";
      readonly cursor: number;
      readonly on: OnTicketEvents;
    };

const OPEN = 1;
const NORMAL_CLOSURE = 1000;

/** A topic's listeners, each under its own key so each unsubscribes only itself. */
type Listeners = ReadonlyMap<symbol, Subscription>;

/**
 * A framework-free /ws client. It subscribes each topic from its lowest listener cursor, and does so
 * again after every reconnect and on `resync`. A topic may hold several listeners, each
 * with its own cursor: a listener never sees an id at or below its own, so a replay asked for one
 * listener never delivers an id twice to another. The server subscription lives while any does.
 */
export class CursorClient {
  readonly #options: CursorClientOptions;
  readonly #backoff: { readonly initialMs: number; readonly maxMs: number };
  readonly #stop = new AbortController();
  #subs: ReadonlyMap<string, Listeners> = new Map();
  #socket: WebSocketLike | null = null;
  #delayMs: number;
  #status: FeedStatus = "connecting";
  #watchers: ReadonlySet<(status: FeedStatus) => void> = new Set();

  constructor(options: CursorClientOptions) {
    this.#options = options;
    this.#backoff = options.reconnect ?? RECONNECT_DEFAULTS;
    this.#delayMs = this.#backoff.initialMs;
    this.#connect();
  }

  /** Events of one session with an id above `since`, in id order, each exactly once. */
  subscribeEvents(sessionId: string, on: OnEvents, since = 0): () => void {
    return this.#subscribe(sessionEventsTopic(sessionId), {
      kind: "events",
      cursor: since,
      on,
    });
  }

  /** Fleet snapshots, at most one a second. */
  subscribeFleet(on: OnFleet): () => void {
    return this.#subscribe(FLEET_TOPIC, { kind: "fleet", cursor: 0, on });
  }

  /** Spend summaries (§8.9), at most one a second and only when they change. */
  subscribeSpend(on: OnSpend): () => void {
    return this.#subscribe(SPEND_TOPIC, { kind: "spend", cursor: 0, on });
  }

  /** The newest pulses (M2), at most one snapshot a second and only when they change. */
  subscribePulses(on: OnPulses): () => void {
    return this.#subscribe(PULSES_TOPIC, { kind: "pulses", cursor: 0, on });
  }

  /** The open human requests: the first page, on subscribe and whenever one opens or closes. */
  subscribeInbox(on: OnInbox): () => void {
    return this.#subscribe(INBOX_TOPIC, { kind: "inbox", cursor: 0, on });
  }

  /** The review queue: running and failed latest attempts, when it changes. */
  subscribeGates(on: OnGates): () => void {
    return this.#subscribe(GATES_TOPIC, { kind: "gates", cursor: 0, on });
  }

  /** Every ticket's `ticket_events` with an id above `since`, in id order, each exactly once. */
  subscribeTickets(on: OnTicketEvents, since = 0): () => void {
    return this.#subscribe(TICKETS_TOPIC, {
      kind: "tickets",
      cursor: since,
      on,
    });
  }

  /** Whether the feed is delivering right now. */
  get status(): FeedStatus {
    return this.#status;
  }

  /** Watches the delivery state, so a reader can say "not connected" instead of showing nothing. */
  subscribeStatus(on: (status: FeedStatus) => void): () => void {
    this.#watchers = new Set([...this.#watchers, on]);
    return () => {
      this.#watchers = new Set([...this.#watchers].filter((w) => w !== on));
    };
  }

  /** The lowest listener cursor on `topic`: the last one received, or a starting `since`. */
  cursor(topic: Topic): number {
    return lowestCursor(this.#subs.get(topic)) ?? 0;
  }

  /** Closes the socket for good; no reconnect follows. */
  close(): void {
    this.#stop.abort();
    this.#socket?.close(NORMAL_CLOSURE, "client closed");
  }

  #subscribe(topic: Topic, sub: Subscription): () => void {
    const key = Symbol(topic);
    const before = this.#subs.get(topic);
    this.#setListeners(topic, new Map(before).set(key, sub));
    if (needsSubscribe(before, sub)) this.#sendSubscribe(topic);
    return () => this.#unsubscribe(topic, key);
  }

  /** Drops one listener, once; the server hears only when the topic's last one leaves. */
  #unsubscribe(topic: string, key: symbol): void {
    const listeners = this.#subs.get(topic);
    if (listeners?.has(key) !== true) return;
    const rest = new Map(listeners);
    rest.delete(key);
    this.#setListeners(topic, rest);
    if (rest.size === 0) this.#send({ type: "unsubscribe", topic });
  }

  #setListeners(topic: string, listeners: Listeners): void {
    const next = new Map(this.#subs);
    if (listeners.size === 0) next.delete(topic);
    else next.set(topic, listeners);
    this.#subs = next;
  }

  #sendSubscribe(topic: string): void {
    const listeners = this.#subs.get(topic);
    if (listeners !== undefined) this.#send(subscribeFrame(topic, listeners));
  }

  /**
   * Hands a frame to each listener on `topic` still subscribed when its turn comes. `visit` says what
   * that listener gets: its cursor after the frame and the call, or null for nothing. A listener that
   * throws is reported and the rest still get the frame.
   */
  #fanOut(
    topic: string,
    visit: (
      sub: Subscription,
    ) => { readonly cursor: number; readonly call: () => void } | null,
  ): void {
    for (const key of this.#subs.get(topic)?.keys() ?? []) {
      const sub = this.#subs.get(topic)?.get(key);
      if (sub === undefined) continue;
      const delivery = visit(sub);
      if (delivery === null) continue;
      const listeners = this.#subs.get(topic);
      if (listeners !== undefined)
        this.#setListeners(
          topic,
          new Map(listeners).set(key, { ...sub, cursor: delivery.cursor }),
        );
      try {
        delivery.call();
      } catch (cause) {
        this.#options.onError({
          class: "internal",
          message: `a ${topic} listener threw`,
          retryable: false,
          cause,
        });
      }
    }
  }

  #connect(): void {
    if (this.#stop.signal.aborted) return;
    let socket: WebSocketLike;
    try {
      socket = this.#options.connect();
    } catch (cause) {
      this.#options.onError({
        class: "internal",
        message: "could not open the WebSocket",
        retryable: true,
        cause,
      });
      this.#setStatus("reconnecting");
      this.#reconnectLater();
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => this.#onOpen(socket));
    socket.addEventListener("message", (event) =>
      this.#onMessage(socket, event.data),
    );
    socket.addEventListener("close", () => this.#onDead(socket));
    // Node 22's WebSocket fires only `error`, never `close`, for a refused or aborted connect.
    socket.addEventListener("error", () => this.#onDead(socket));
  }

  #onOpen(socket: WebSocketLike): void {
    if (socket !== this.#socket) return;
    this.#delayMs = this.#backoff.initialMs;
    this.#setStatus("open");
    for (const topic of this.#subs.keys()) this.#sendSubscribe(topic);
  }

  /** `error` or `close`, whichever comes first, ends a socket; the second is ignored. */
  #onDead(socket: WebSocketLike): void {
    if (socket !== this.#socket) return;
    this.#socket = null;
    socket.close();
    // A refused connect, a 401 at the handshake and a mid-life drop all land here. Saying so once
    // per death is what stops a reader rendering a dead feed as "nothing happened".
    if (this.#status === "open")
      this.#options.onError({
        class: "internal",
        message: "the /ws feed dropped; reconnecting",
        retryable: true,
      });
    this.#setStatus("reconnecting");
    this.#reconnectLater();
  }

  #setStatus(status: FeedStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    for (const watcher of this.#watchers) watcher(status);
  }

  #reconnectLater(): void {
    if (this.#stop.signal.aborted) return;
    const delay = this.#delayMs;
    this.#delayMs = Math.min(delay * 2, this.#backoff.maxMs);
    this.#options.clock.after(delay, this.#stop.signal).then(
      () => this.#connect(),
      () => undefined, // aborted by close(): nothing left to do
    );
  }

  #onMessage(socket: WebSocketLike, data: unknown): void {
    if (socket !== this.#socket) return;
    const frame = parseFrame(data);
    if (!frame.ok) {
      this.#options.onError({
        class: "validation",
        message: frame.message,
        retryable: false,
      });
      return;
    }
    const value = frame.value;
    switch (value.type) {
      case "events":
        return this.#onEvents(value);
      case "ticket_events":
        return this.#onTicketEvents(value);
      case "fleet":
        return this.#onFleet(value);
      case "spend":
        return this.#onSpend(value);
      case "pulses":
        return this.#onPulses(value);
      case "inbox":
        return this.#onInbox(value);
      case "gates":
        return this.#onGates(value);
      case "resync":
        return this.#sendSubscribe(value.topic);
      case "error":
        return this.#options.onError(value.error);
    }
  }

  #onEvents(frame: EventsFrame): void {
    this.#fanOut(frame.topic, (sub) => {
      if (sub.kind !== "events") return null;
      const { fresh, cursor } = above(frame.items, sub.cursor);
      return fresh.length === 0
        ? null
        : { cursor, call: () => sub.on(fresh, cursor) };
    });
  }

  #onTicketEvents(frame: TicketEventsFrame): void {
    this.#fanOut(frame.topic, (sub) => {
      if (sub.kind !== "tickets") return null;
      const { fresh, cursor } = above(frame.items, sub.cursor);
      return fresh.length === 0
        ? null
        : { cursor, call: () => sub.on(fresh, cursor) };
    });
  }

  #onFleet(frame: FleetFrame): void {
    this.#fanOut(frame.topic, (sub) =>
      sub.kind === "fleet" ? snapshot(frame, sub.on) : null,
    );
  }

  #onSpend(frame: SpendFrame): void {
    this.#fanOut(frame.topic, (sub) =>
      sub.kind === "spend" ? snapshot(frame, sub.on) : null,
    );
  }

  #onPulses(frame: PulsesFrame): void {
    this.#fanOut(frame.topic, (sub) =>
      sub.kind === "pulses" ? snapshot(frame, sub.on) : null,
    );
  }

  #onInbox(frame: InboxFrame): void {
    this.#fanOut(frame.topic, (sub) =>
      sub.kind === "inbox" ? snapshot(frame, sub.on) : null,
    );
  }

  #onGates(frame: GatesFrame): void {
    this.#fanOut(frame.topic, (sub) =>
      sub.kind === "gates" ? snapshot(frame, sub.on) : null,
    );
  }

  #send(frame: ClientFrame): void {
    if (this.#socket?.readyState === OPEN)
      this.#socket.send(JSON.stringify(frame));
  }
}

/** The items above `cursor`, in order, and the cursor after them: a replay never repeats an id. */
function above<T extends { readonly id: number }>(
  items: readonly T[],
  cursor: number,
): { readonly fresh: readonly T[]; readonly cursor: number } {
  const fresh: T[] = [];
  let last = cursor;
  for (const item of items) {
    if (item.id <= last) continue;
    fresh.push(item);
    last = item.id;
  }
  return { fresh, cursor: last };
}

/** A whole snapshot, delivered with the frame's cursor. */
const snapshot = <T>(
  frame: { readonly cursor: number; readonly data: T },
  on: (data: T, cursor: number) => void,
) => ({ cursor: frame.cursor, call: () => on(frame.data, frame.cursor) });

const isPaged = (sub: Subscription): boolean =>
  sub.kind === "events" || sub.kind === "tickets";

/** The lowest cursor among a topic's listeners, or null when it has none. */
function lowestCursor(listeners: Listeners | undefined): number | null {
  const cursors = [...(listeners?.values() ?? [])].map((sub) => sub.cursor);
  return cursors.length === 0 ? null : Math.min(...cursors);
}

/**
 * Whether a new listener needs a `subscribe` frame: the topic's first does; a snapshot topic's next
 * one does, so the server sends it a snapshot now; a cursor-paged topic's next one does only when it
 * starts below every cursor there, so the server replays from it.
 */
function needsSubscribe(
  before: Listeners | undefined,
  sub: Subscription,
): boolean {
  const lowest = lowestCursor(before);
  if (lowest === null || !isPaged(sub)) return true;
  return sub.cursor < lowest;
}

/** Snapshot frames (fleet, spend, pulses, inbox) are whole; the cursor-paged topics resume from the
 * lowest cursor any listener holds. */
function subscribeFrame(topic: string, listeners: Listeners): ClientFrame {
  const first = listeners.values().next().value;
  const since = lowestCursor(listeners);
  return first !== undefined && isPaged(first) && since !== null
    ? { type: "subscribe", topic, since }
    : { type: "subscribe", topic };
}

type Parsed =
  | { readonly ok: true; readonly value: ServerFrame }
  | { readonly ok: false; readonly message: string };

function parseFrame(data: unknown): Parsed {
  if (typeof data !== "string")
    return { ok: false, message: "a frame must be text" };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, message: "a frame must be JSON" };
  }
  const parsed = ServerFrame.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, message: z.prettifyError(parsed.error) };
}
