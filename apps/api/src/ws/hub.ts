import type { Clock, FrmError, Result } from "@bayon/core";
import {
  ClientFrame,
  FLEET_TOPIC,
  GATES_TOPIC,
  INBOX_TOPIC,
  PULSES_TOPIC,
  SPEND_TOPIC,
  TICKETS_TOPIC,
  parseTopic,
  type EventsPage,
  type Fleet,
  type GatesPage,
  type InboxPage,
  type InboxQuery,
  type ParsedTopic,
  type PulsesPage,
  type ServerFrame,
  type SpendSummary,
  type TicketEventsPage,
  type WireError,
} from "@bayon/proto";
import { z } from "zod";

// The /ws protocol of contract 7, free of Nest and of `ws`. Every subscription tails the DB: replay
// and live are the same loop (amendment 9), so it survives either process restarting.

/** The part of a `ws` socket a connection uses. */
export interface HubSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
}

/** The reads the feed needs; the API's store provides them. */
export interface FeedSource {
  eventsSince(q: {
    readonly sessionId: string;
    readonly since: number;
    readonly limit: number;
  }): Promise<Result<EventsPage>>;
  /** Every ticket's ticket_events after `since` (the `tickets` topic, M1 contract 8). */
  ticketEventsSince(q: {
    readonly since: number;
    readonly limit: number;
  }): Promise<Result<TicketEventsPage>>;
  fleet(): Promise<Result<Fleet>>;
  /** The spend ledger's summary (the `spend` topic, §8.9). */
  spendSummary(): Promise<Result<SpendSummary>>;
  /** A page of human requests (the `inbox` topic reads the open ones' first page). */
  inbox(q: InboxQuery): Promise<Result<InboxPage>>;
  /** The newest pulses of every agent (the `pulses` topic, M2). */
  recentPulses(): Promise<Result<PulsesPage>>;
  /** The review queue: running and failed latest attempts (the `gates` topic). */
  gates?(): Promise<Result<GatesPage>>;
}

export interface WsTuning {
  /** How often an events subscription reads the DB once caught up. */
  readonly tailMs: number;
  /** Snapshot topics (fleet, spend, pulses) are read, and sent when changed, this often (1 Hz, §12.2). */
  readonly fleetMs: number;
  /** Inbox snapshots are read, and sent when changed, this often. */
  readonly inboxMs: number;
  /** Events per frame, and per read. */
  readonly pageLimit: number;
  /** A client with more than this unsent is slow: it gets `resync`, not back-pressure. */
  readonly highWaterBytes: number;
}

export const WS_TUNING: WsTuning = {
  tailMs: 200,
  fleetMs: 1_000,
  inboxMs: 1_000,
  pageLimit: 200,
  highWaterBytes: 1_048_576,
};

/**
 * `source`, with one spend summary read per `ttlMs` shared by every caller. The summary is a
 * snapshot of about ten aggregates, so N `spend` subscribers cost one read per tick, not N. A call
 * within `ttlMs` of the last read gets that read's result, an error included; the next tick reads
 * again.
 */
export function shareSpendSummary(
  source: FeedSource,
  clock: Clock,
  ttlMs: number,
): FeedSource {
  let last:
    | { readonly at: number; readonly summary: Promise<Result<SpendSummary>> }
    | undefined;
  const gates = source.gates?.bind(source);
  return {
    eventsSince: (q) => source.eventsSince(q),
    ticketEventsSince: (q) => source.ticketEventsSince(q),
    fleet: () => source.fleet(),
    inbox: (q) => source.inbox(q),
    recentPulses: () => source.recentPulses(),
    ...(gates === undefined ? {} : { gates }),
    spendSummary: () => {
      const now = clock.now();
      if (last === undefined || now - last.at >= ttlMs)
        last = { at: now, summary: source.spendSummary() };
      return last.summary;
    },
  };
}

export interface ConnectionDeps {
  readonly source: FeedSource;
  readonly clock: Clock;
  readonly tuning: WsTuning;
  /** Server-side log for read errors the client does not need to see. */
  readonly log: (error: FrmError) => void;
}

/** A cursor-paged read: a page after `since`, and where the next one starts. */
interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: number;
  readonly has_more: boolean;
}

const OPEN = 1;

/** One client socket and its subscriptions, one tail loop per topic. */
export class WsConnection {
  readonly #socket: HubSocket;
  readonly #deps: ConnectionDeps;
  readonly #closed = new AbortController();
  #subs: ReadonlyMap<string, AbortController> = new Map();

  constructor(socket: HubSocket, deps: ConnectionDeps) {
    this.#socket = socket;
    this.#deps = deps;
  }

  /** Handles one text frame from the client. */
  receive(data: string): void {
    if (this.#closed.signal.aborted) return;
    const frame = parseClientFrame(data);
    if (!frame.ok) {
      this.#send({
        type: "error",
        cursor: 0,
        error: validation(frame.message),
      });
      return;
    }
    if (frame.value.type === "unsubscribe") this.#stop(frame.value.topic);
    else this.#subscribe(frame.value.topic, frame.value.since ?? 0);
  }

  /** Stops every loop. Call it when the socket closes. */
  close(): void {
    this.#closed.abort();
    for (const sub of this.#subs.values()) sub.abort();
    this.#subs = new Map();
  }

  #subscribe(topic: string, since: number): void {
    const parsed = parseTopic(topic);
    if (!parsed) {
      this.#send({
        type: "error",
        topic,
        cursor: since,
        error: validation(`unknown topic: ${topic}`),
      });
      return;
    }
    this.#stop(topic);
    const sub = new AbortController();
    this.#subs = new Map(this.#subs).set(topic, sub);
    this.#loop(parsed, topic, since, sub.signal)
      .catch((cause: unknown) =>
        this.#deps.log({
          class: "internal",
          message: `ws tail for ${topic} crashed`,
          retryable: false,
          cause,
        }),
      )
      .finally(() => this.#release(topic, sub));
  }

  #loop(
    parsed: ParsedTopic,
    topic: string,
    since: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { source, tuning } = this.#deps;
    switch (parsed.kind) {
      case "fleet":
        return this.#tailSnapshot(
          FLEET_TOPIC,
          signal,
          () => source.fleet(),
          (cursor, data) => ({
            type: "fleet",
            topic: FLEET_TOPIC,
            cursor,
            data,
          }),
          tuning.fleetMs,
        );
      case "spend":
        return this.#tailSnapshot(
          SPEND_TOPIC,
          signal,
          () => source.spendSummary(),
          (cursor, data) => ({
            type: "spend",
            topic: SPEND_TOPIC,
            cursor,
            data,
          }),
          tuning.fleetMs,
        );
      case "inbox":
        return this.#tailSnapshot(
          INBOX_TOPIC,
          signal,
          () => source.inbox({ status: "open", limit: tuning.pageLimit }),
          (cursor, data) => ({
            type: "inbox",
            topic: INBOX_TOPIC,
            cursor,
            data,
          }),
          tuning.inboxMs,
        );
      case "pulses":
        return this.#tailSnapshot(
          PULSES_TOPIC,
          signal,
          () => source.recentPulses(),
          (cursor, data) => ({
            type: "pulses",
            topic: PULSES_TOPIC,
            cursor,
            data,
          }),
          tuning.fleetMs,
        );
      case "gates": {
        const gates = source.gates?.bind(source);
        if (gates === undefined) {
          this.#send({
            type: "error",
            topic,
            cursor: 0,
            error: validation("the gates topic is not served here"),
          });
          return Promise.resolve();
        }
        return this.#tailSnapshot(
          GATES_TOPIC,
          signal,
          gates,
          (cursor, data) => ({
            type: "gates",
            topic: GATES_TOPIC,
            cursor,
            data,
          }),
          tuning.fleetMs,
        );
      }
      case "tickets":
        return this.#tailPages(
          topic,
          since,
          signal,
          (after, limit) => source.ticketEventsSince({ since: after, limit }),
          (cursor, items) => ({
            type: "ticket_events",
            topic: TICKETS_TOPIC,
            cursor,
            items: [...items],
          }),
        );
      case "session_events": {
        const { sessionId } = parsed;
        return this.#tailPages(
          topic,
          since,
          signal,
          (after, limit) =>
            source.eventsSince({ sessionId, since: after, limit }),
          (cursor, items) => ({
            type: "events",
            topic,
            cursor,
            items: [...items],
          }),
        );
      }
    }
  }

  #stop(topic: string): void {
    const sub = this.#subs.get(topic);
    if (!sub) return;
    sub.abort();
    this.#release(topic, sub);
  }

  /** Forgets a subscription, unless the topic was subscribed again since. */
  #release(topic: string, sub: AbortController): void {
    if (this.#subs.get(topic) !== sub) return;
    const rest = new Map(this.#subs);
    rest.delete(topic);
    this.#subs = rest;
  }

  /** Replays a cursor-paged feed after `since`, back to back, then tails it every tailMs. */
  async #tailPages<T>(
    topic: string,
    since: number,
    signal: AbortSignal,
    read: (since: number, limit: number) => Promise<Result<Page<T>>>,
    frame: (cursor: number, items: readonly T[]) => ServerFrame,
  ): Promise<void> {
    const { tuning } = this.#deps;
    let cursor = since;
    while (!signal.aborted) {
      const page = await read(cursor, tuning.pageLimit);
      if (signal.aborted) return;
      if (!page.ok) {
        if (!this.#readFailed(topic, cursor, page.error)) return;
      } else if (page.value.items.length > 0) {
        if (this.#socket.bufferedAmount > tuning.highWaterBytes) {
          this.#send({ type: "resync", topic, cursor });
          return;
        }
        cursor = page.value.next_cursor;
        this.#send(frame(cursor, page.value.items));
        if (page.value.has_more) continue;
      }
      if (!(await this.#wait(tuning.tailMs, signal))) return;
    }
  }

  /**
   * Reads a whole snapshot every `everyMs` (the topic's interval) and sends it when it differs from
   * the last one sent; a slow client skips snapshots until it drains. The cursor is the snapshot time.
   */
  async #tailSnapshot<T>(
    topic: string,
    signal: AbortSignal,
    read: () => Promise<Result<T>>,
    frame: (cursor: number, data: T) => ServerFrame,
    everyMs: number,
  ): Promise<void> {
    const { tuning, clock } = this.#deps;
    let sentJson = "";
    let cursor = 0;
    while (!signal.aborted) {
      const snapshot = await read();
      if (signal.aborted) return;
      if (!snapshot.ok) {
        if (!this.#readFailed(topic, cursor, snapshot.error)) return;
      } else {
        const json = JSON.stringify(snapshot.value);
        const drained = this.#socket.bufferedAmount <= tuning.highWaterBytes;
        if (json !== sentJson && drained) {
          sentJson = json;
          cursor = clock.now();
          this.#send(frame(cursor, snapshot.value));
        }
      }
      if (!(await this.#wait(everyMs, signal))) return;
    }
  }

  /** Logs a failed read. Retryable: true (try again next tick). Otherwise tells the client: false. */
  #readFailed(topic: string, cursor: number, error: FrmError): boolean {
    this.#deps.log(error);
    if (error.retryable) return true;
    this.#send({ type: "error", topic, cursor, error: toWire(error) });
    return false;
  }

  /** True once `ms` has passed; false if the subscription stopped first. */
  #wait(ms: number, signal: AbortSignal): Promise<boolean> {
    return this.#deps.clock.after(ms, signal).then(
      () => true,
      () => false,
    );
  }

  #send(frame: ServerFrame): void {
    if (this.#socket.readyState === OPEN)
      this.#socket.send(JSON.stringify(frame));
  }
}

const validation = (message: string): WireError => ({
  class: "validation",
  message,
  retryable: false,
});

const toWire = (error: FrmError): WireError => ({
  class: error.class,
  message: error.message,
  retryable: error.retryable,
});

type ParsedFrame =
  | { readonly ok: true; readonly value: ClientFrame }
  | { readonly ok: false; readonly message: string };

function parseClientFrame(data: string): ParsedFrame {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, message: "a frame must be JSON" };
  }
  const parsed = ClientFrame.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, message: z.prettifyError(parsed.error) };
}
