// What the notifier tells the operator about, and where. The event kinds are one list,
// and a kind's bit in a channel's `notify.<channel>.events` mask is its index here: the whitelist
// holds numbers only, so a set of kinds is a bitmask (question = 1, staff_proposal = 2, … = 127 all).
import { z } from "zod";

export const NOTIFY_EVENT_KINDS = [
  /** An open human request of any kind but a staffing proposal: an agent's, or the watchdog's. */
  "question",
  /** An orchestrator's staffing proposal, waiting on the operator's approval. */
  "staff_proposal",
  /** A ticket entered `qa_human`: the operator's own QA. */
  "qa_human",
  /** The circuit breaker blocked a ticket (the watchdog's `blockTicket`). */
  "ticket_blocked",
  /** A project's Jira sync failed after one that did not. */
  "jira_sync_failed",
  /** A budget passed its warning level (once per budget per UTC day). */
  "budget_warn",
  /** A human-only attention arm stands (once per row per UTC day). */
  "attention",
] as const;
export const NotifyEventKind = z.enum(NOTIFY_EVENT_KINDS);
export type NotifyEventKind = z.infer<typeof NotifyEventKind>;

/** A kind's bit in an events mask. */
export const eventBit = (kind: NotifyEventKind): number =>
  1 << NOTIFY_EVENT_KINDS.indexOf(kind);

/** Every kind: the mask a channel subscribes with by default. */
export const ALL_NOTIFY_EVENTS = (1 << NOTIFY_EVENT_KINDS.length) - 1;

/** Whether an events mask includes `kind`. */
export const subscribes = (mask: number, kind: NotifyEventKind): boolean =>
  (mask & eventBit(kind)) !== 0;

/** The kinds a mask names, in list order. */
export const eventsOfMask = (mask: number): NotifyEventKind[] =>
  NOTIFY_EVENT_KINDS.filter((kind) => subscribes(mask, kind));

export const NOTIFY_CHANNELS = ["mac", "ntfy", "webhook", "email"] as const;
export const NotifyChannel = z.enum(NOTIFY_CHANNELS);
export type NotifyChannel = z.infer<typeof NotifyChannel>;

/**
 * The host-store secret each channel's destination lives in (§14 amendment): never in the DB, a
 * setting or a response. mac needs none: it is this host's own Notification Center.
 */
export const NOTIFY_NTFY_URL_SECRET = "NOTIFY_NTFY_URL";
export const NOTIFY_WEBHOOK_URL_SECRET = "NOTIFY_WEBHOOK_URL";
export const NOTIFY_SMTP_URL_SECRET = "NOTIFY_SMTP_URL";
export const NOTIFY_CHANNEL_SECRET: Readonly<
  Record<NotifyChannel, string | null>
> = {
  mac: null,
  ntfy: NOTIFY_NTFY_URL_SECRET,
  webhook: NOTIFY_WEBHOOK_URL_SECRET,
  email: NOTIFY_SMTP_URL_SECRET,
};

export const DELIVERY_STATES = [
  "pending",
  "sent",
  "failed",
  "skipped",
] as const;
export const DeliveryState = z.enum(DELIVERY_STATES);
export type DeliveryState = z.infer<typeof DeliveryState>;

/** `notify.<channel>.enabled` and `notify.<channel>.events`, as OPERATOR_SETTINGS names them. */
export const notifyEnabledKey = <C extends NotifyChannel>(
  channel: C,
): `notify.${C}.enabled` => `notify.${channel}.enabled`;
export const notifyEventsKey = <C extends NotifyChannel>(
  channel: C,
): `notify.${C}.events` => `notify.${channel}.events`;
export const NOTIFY_POLL_KEY = "notify.poll_ms";
export const NOTIFY_QUIET_START_KEY = "notify.quiet_start_hour";
export const NOTIFY_QUIET_END_KEY = "notify.quiet_end_hour";
