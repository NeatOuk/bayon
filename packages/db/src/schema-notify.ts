import type { DeliveryState } from "@bayon/core";
import type { Generated, Selectable } from "kysely";

// Hand-written Kysely types for the notifications migration. schema-columns-notify.ts
// restates them at runtime, and schema.test.ts checks that against PRAGMA table_info. All three are
// API-written (§9.5 amendment).

/** One moment, filed once by its dedupe key. */
export interface NotificationsTable {
  id: string;
  /** core NotifyEventKind, checked by the writer's schema. */
  event_kind: string;
  dedupe_key: string;
  workspace_id: string | null;
  ticket_id: string | null;
  title: string;
  /** At most 1000 characters (CHECK). */
  body: string;
  /** A GUI hash path, `#/…`; the origin is joined at send time. */
  link_path: string | null;
  created_at: number;
}

/** One channel's delivery of one notification. */
export interface NotificationDeliveriesTable {
  notification_id: string;
  /** core NotifyChannel, checked by the writer's schema. */
  channel: string;
  state: Generated<DeliveryState>;
  attempts: Generated<number>;
  /** Scrubbed of every secret, at most 500 characters (CHECK). */
  last_error: string | null;
  /** When a pending delivery is next due; NULL is due now. */
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  sent_at: number | null;
}

/** The notifier's watermark on one source table: the last rowid it read. */
export interface NotificationCursorsTable {
  source: string;
  last_seen: number;
  updated_at: number;
}

export interface NotifyDB {
  notifications: NotificationsTable;
  notification_deliveries: NotificationDeliveriesTable;
  notification_cursors: NotificationCursorsTable;
}

export type NotificationRow = Selectable<NotificationsTable>;
export type NotificationDeliveryRow = Selectable<NotificationDeliveriesTable>;
