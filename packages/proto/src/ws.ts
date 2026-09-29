import { z } from "zod";
import { GatesPage } from "./gates.js";
import { InboxPage } from "./inbox.js";
import { PulsesPage } from "./pulses.js";
import { EventItem, Fleet, WireError } from "./rest.js";
import { SpendSummary } from "./spend.js";
import { TicketEventView } from "./tickets.js";

// Contract 7: the /ws protocol. Cursor rules:
// - `session:<id>:events`: the cursor is an `events.id`, exclusive. `subscribe {since}` replays every
//   event with a larger id, then keeps going live; ids arrive strictly increasing. No `since` means 0.
// - `tickets` (M1 contract 8): every ticket's `ticket_events`, by the same rule, the cursor a
//   `ticket_events.id`. A GUI refetches the tickets an item names.
// - `fleet`, `spend` (§8.9) and `pulses` (M2: the newest pulses, whose rows change state in place): a
//   frame is a complete snapshot, sent when it changes, so `since` is ignored; the cursor is the
//   snapshot time.
// - `inbox`: a snapshot too: the open human requests (the first page of
//   `GET /inbox?status=open`), sent on subscribe and again whenever a request opens or is answered.
// - `gates`: a snapshot too: the review queue, the first page of
//   `GET /gates?state=running,failed&latest=1`, sent when it changes.
// - Every server frame carries a cursor. `resync {topic}` means the server dropped a subscription
//   because the client fell behind: resubscribe from the last id you actually received.
// - Subscribing to a topic you already hold restarts it from the new `since`.

/** An `events.id` or `ticket_events.id` (exclusive) or, for a snapshot topic, a snapshot time. */
export const Cursor = z.int().nonnegative();

export const FLEET_TOPIC = "fleet";
export const TICKETS_TOPIC = "tickets";
export const SPEND_TOPIC = "spend";
export const INBOX_TOPIC = "inbox";
export const PULSES_TOPIC = "pulses";
export const GATES_TOPIC = "gates";
export type Topic =
  | typeof FLEET_TOPIC
  | typeof TICKETS_TOPIC
  | typeof SPEND_TOPIC
  | typeof INBOX_TOPIC
  | typeof PULSES_TOPIC
  | typeof GATES_TOPIC
  | `session:${string}:events`;
export type ParsedTopic =
  | { readonly kind: "fleet" }
  | { readonly kind: "tickets" }
  | { readonly kind: "spend" }
  | { readonly kind: "inbox" }
  | { readonly kind: "pulses" }
  | { readonly kind: "gates" }
  | { readonly kind: "session_events"; readonly sessionId: string };

const SESSION_EVENTS = /^session:([A-Za-z0-9_-]+):events$/;

/** The topic, or null when the server does not serve it. */
export const parseTopic = (topic: string): ParsedTopic | null => {
  if (topic === FLEET_TOPIC) return { kind: "fleet" };
  if (topic === TICKETS_TOPIC) return { kind: "tickets" };
  if (topic === SPEND_TOPIC) return { kind: "spend" };
  if (topic === INBOX_TOPIC) return { kind: "inbox" };
  if (topic === PULSES_TOPIC) return { kind: "pulses" };
  if (topic === GATES_TOPIC) return { kind: "gates" };
  const sessionId = SESSION_EVENTS.exec(topic)?.[1];
  return sessionId === undefined ? null : { kind: "session_events", sessionId };
};

export const sessionEventsTopic = (sessionId: string): Topic =>
  `session:${sessionId}:events`;

/** Client → server. */
export const ClientFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    topic: z.string(),
    since: Cursor.optional(),
  }),
  z.object({ type: z.literal("unsubscribe"), topic: z.string() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const EventsFrame = z.object({
  type: z.literal("events"),
  topic: z.string(),
  cursor: Cursor,
  items: z.array(EventItem),
});
export type EventsFrame = z.infer<typeof EventsFrame>;

export const TicketEventsFrame = z.object({
  type: z.literal("ticket_events"),
  topic: z.literal(TICKETS_TOPIC),
  cursor: Cursor,
  items: z.array(TicketEventView),
});
export type TicketEventsFrame = z.infer<typeof TicketEventsFrame>;

export const FleetFrame = z.object({
  type: z.literal("fleet"),
  topic: z.literal(FLEET_TOPIC),
  cursor: Cursor,
  data: Fleet,
});
export type FleetFrame = z.infer<typeof FleetFrame>;

export const SpendFrame = z.object({
  type: z.literal("spend"),
  topic: z.literal(SPEND_TOPIC),
  cursor: Cursor,
  data: SpendSummary,
});
export type SpendFrame = z.infer<typeof SpendFrame>;

export const InboxFrame = z.object({
  type: z.literal("inbox"),
  topic: z.literal(INBOX_TOPIC),
  cursor: Cursor,
  data: InboxPage,
});
export type InboxFrame = z.infer<typeof InboxFrame>;

export const PulsesFrame = z.object({
  type: z.literal("pulses"),
  topic: z.literal(PULSES_TOPIC),
  cursor: Cursor,
  data: PulsesPage,
});
export type PulsesFrame = z.infer<typeof PulsesFrame>;

export const GatesFrame = z.object({
  type: z.literal("gates"),
  topic: z.literal(GATES_TOPIC),
  cursor: Cursor,
  data: GatesPage,
});
export type GatesFrame = z.infer<typeof GatesFrame>;

export const ResyncFrame = z.object({
  type: z.literal("resync"),
  topic: z.string(),
  cursor: Cursor,
});
export type ResyncFrame = z.infer<typeof ResyncFrame>;

export const ErrorFrame = z.object({
  type: z.literal("error"),
  topic: z.string().optional(),
  cursor: Cursor,
  error: WireError,
});
export type ErrorFrame = z.infer<typeof ErrorFrame>;

/** Server → client. */
export const ServerFrame = z.discriminatedUnion("type", [
  EventsFrame,
  TicketEventsFrame,
  FleetFrame,
  SpendFrame,
  InboxFrame,
  PulsesFrame,
  GatesFrame,
  ResyncFrame,
  ErrorFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** An events frame's cursor: its last item's id, or `since` when it has no items. */
export const frameCursor = (
  items: readonly { readonly id: number }[],
  since: number,
): number => items.at(-1)?.id ?? since;
