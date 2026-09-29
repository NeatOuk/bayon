import {
  DeliveryState,
  ErrorClass,
  NotifyChannel,
  NotifyConfigPatch,
  NotifyConfigValues,
  NotifyEventKind,
} from "@bayon/core";
import { z } from "zod";
import { KeychainScopeView, SecretStoreKindView } from "./secret-store.js";

// The notifier's REST door: each channel's status, a test send, and the outbox. No
// destination or credential crosses it (§14 amendment): a channel is `configured` or not, and names
// the host-store secret to set, never its value.

const epochMs = z.int().nonnegative();

/** `GET /notifications/channels`: one row per channel. */
export const NotifyChannelStatus = z.object({
  channel: NotifyChannel,
  /** `notify.<channel>.enabled`. */
  enabled: z.boolean(),
  /** The secret is in the host store (email: and `notify.email.to` is set); mac: this is a Mac. */
  configured: z.boolean(),
  /** Which host store answers: the Mac's Keychain, or the docker host's files. */
  store: SecretStoreKindView,
  /** Which install's Keychain service the API reads; null with the file store. */
  keychain: KeychainScopeView.nullable(),
  /** The secret's name to store, null for mac. */
  secret: z.string().nullable(),
  last_sent_at: epochMs.nullable(),
  /** The newest delivery error since the last send, scrubbed. */
  last_error: z.string().optional(),
});
export type NotifyChannelStatus = z.infer<typeof NotifyChannelStatus>;
export const NotifyChannelsView = z.array(NotifyChannelStatus);
export type NotifyChannelsView = z.infer<typeof NotifyChannelsView>;

/** `POST /notifications/test`. An unknown channel is 400. */
export const NotifyTestRequest = z.strictObject({ channel: NotifyChannel });
export type NotifyTestRequest = z.infer<typeof NotifyTestRequest>;

export const NotifyTestResult = z.object({
  channel: NotifyChannel,
  sent: z.boolean(),
  /** Why not, scrubbed of every secret. */
  error: z
    .object({ class: ErrorClass, message: z.string(), retryable: z.boolean() })
    .optional(),
});
export type NotifyTestResult = z.infer<typeof NotifyTestResult>;

export const NotificationDeliveryView = z.object({
  channel: NotifyChannel,
  state: DeliveryState,
  attempts: z.int().nonnegative(),
  last_error: z.string().nullable(),
  next_attempt_at: epochMs.nullable(),
  last_attempt_at: epochMs.nullable(),
  sent_at: epochMs.nullable(),
});

export const NotificationView = z.object({
  id: z.string(),
  event_kind: NotifyEventKind,
  workspace_id: z.string().nullable(),
  ticket_id: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  /** A GUI hash path, `#/…`. */
  link_path: z.string().nullable(),
  created_at: epochMs,
  deliveries: z.array(NotificationDeliveryView),
});
export type NotificationView = z.infer<typeof NotificationView>;

export const NOTIFICATIONS_PAGE_DEFAULT_LIMIT = 50;
export const NOTIFICATIONS_PAGE_MAX_LIMIT = 100;

/** `GET /notifications?cursor&limit`: newest first; `cursor` is a page's `next_cursor`. */
export const NotificationsQuery = z.strictObject({
  cursor: z.coerce.number().pipe(z.int().positive()).optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(NOTIFICATIONS_PAGE_MAX_LIMIT))
    .default(NOTIFICATIONS_PAGE_DEFAULT_LIMIT),
});
export type NotificationsQuery = z.infer<typeof NotificationsQuery>;

export const NotificationsPage = z.object({
  items: z.array(NotificationView),
  next_cursor: z.int().positive().nullable(),
});
export type NotificationsPage = z.infer<typeof NotificationsPage>;

/**
 * `GET /notifications/config` and the answer to its PUT: the three destination settings
 * as they stand, "" unset. Settings, not secrets — the ntfy, webhook and SMTP destinations stay in
 * the host store and never cross this door.
 */
export const NotifyConfigView = NotifyConfigValues;
export type NotifyConfigView = z.infer<typeof NotifyConfigView>;

/**
 * `PUT /notifications/config`: these three names and no other (a strict object), each checked by the
 * schema the shell door uses. Every change is audited and announced (§14).
 */
export const PutNotifyConfig = NotifyConfigPatch;
export type PutNotifyConfig = z.infer<typeof PutNotifyConfig>;
