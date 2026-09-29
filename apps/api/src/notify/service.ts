import {
  NOTIFY_CHANNELS,
  NOTIFY_CHANNEL_SECRET,
  TEST_NOTIFICATION,
  err,
  notifyLink,
  ok,
  type Clock,
  type NotifyChannel,
  type Result,
} from "@bayon/core";
import { listNotifications, notifyChannelStats, type Db } from "@bayon/db";
import { appendAudit } from "@bayon/db/api";
import {
  NotificationsPage,
  NotifyChannelsView,
  type KeychainScopeView,
  type NotificationsQuery,
  type NotifyConfigView,
  type NotifyTestResult,
  type PutNotifyConfig,
} from "@bayon/proto";
import { parseAs } from "../dto.js";
import type { ChannelSet } from "./channels/index.js";
import { readNotifyConfig, writeNotifyConfig } from "./config.js";
import type { NotifyLogger } from "./deliver.js";
import { loadNotifySettings } from "./settings.js";

// The notifier's REST door: each channel's status (booleans and a secret's name, never
// its value, as GET /jira), a test send through one channel now — audited, and at most one per
// channel every few seconds, so the button cannot be used to flood a destination — and the outbox.

export const NOTIFY_TEST_COOLDOWN_MS = 5_000;
const OPERATOR = "operator";

export interface NotificationsServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly channels: ChannelSet;
  /**
   * Which host store the secrets are read from, and this install's Keychain service:
   * what the GUI's store step names and builds its command from.
   */
  readonly store: {
    readonly kind: "keychain" | "file";
    readonly keychain: KeychainScopeView | null;
  };
  /** Where a change alert that could not be sent is said; the PUT still answers. */
  readonly logger: NotifyLogger;
}

export class NotificationsService {
  readonly #deps: NotificationsServiceDeps;
  readonly #lastTest = new Map<NotifyChannel, number>();

  constructor(deps: NotificationsServiceDeps) {
    this.#deps = deps;
  }

  /** `GET /notifications/channels`. */
  async channels(): Promise<Result<NotifyChannelsView>> {
    const { db, channels, store } = this.#deps;
    const { settings } = await loadNotifySettings(db);
    const stats = await notifyChannelStats(db);
    if (!stats.ok) return stats;
    const rows = await Promise.all(
      NOTIFY_CHANNELS.map(async (channel) => {
        const stat = stats.value.find((s) => s.channel === channel);
        return {
          channel,
          enabled: settings.channels[channel].enabled,
          configured: await channels[channel].configured(),
          store: store.kind,
          keychain: store.keychain,
          secret: NOTIFY_CHANNEL_SECRET[channel],
          last_sent_at: stat?.last_sent_at ?? null,
          ...(stat?.last_error == null ? {} : { last_error: stat.last_error }),
        };
      }),
    );
    return parseAs(NotifyChannelsView, rows, "notification channels");
  }

  /** `POST /notifications/test`: one test send now, whatever `enabled` and quiet hours say. */
  async test(channel: NotifyChannel): Promise<Result<NotifyTestResult>> {
    const { db, clock, channels } = this.#deps;
    const now = clock.now();
    const last = this.#lastTest.get(channel);
    if (last !== undefined && now - last < NOTIFY_TEST_COOLDOWN_MS) {
      return err({
        class: "conflict",
        message: `a test of ${channel} ran ${now - last} ms ago; wait ${NOTIFY_TEST_COOLDOWN_MS / 1_000} s between tests`,
        retryable: true,
      });
    }
    this.#lastTest.set(channel, now);
    const { settings } = await loadNotifySettings(db);
    const sent = await channels[channel].send({
      ...TEST_NOTIFICATION,
      link: notifyLink(settings.baseUrl, "#/"),
    });
    const result: NotifyTestResult = sent.ok
      ? { channel, sent: true }
      : {
          channel,
          sent: false,
          error: {
            class: sent.error.class,
            message: sent.error.message,
            retryable: sent.error.retryable,
          },
        };
    const audit = await appendAudit(db, {
      actor: OPERATOR,
      action: "notify.test",
      target_kind: "notify_channel",
      target_id: channel,
      payload: {
        sent: result.sent,
        ...(result.error === undefined
          ? {}
          : {
              error: {
                class: result.error.class,
                message: result.error.message,
              },
            }),
      },
    });
    return audit.ok ? ok(result) : audit;
  }

  /** `GET /notifications/config`: the three destination settings, "" unset. */
  async config(): Promise<Result<NotifyConfigView>> {
    return readNotifyConfig(this.#deps.db);
  }

  /** `PUT /notifications/config`: those three names only, audited and announced (§14). */
  async putConfig(patch: PutNotifyConfig): Promise<Result<NotifyConfigView>> {
    return writeNotifyConfig(this.#deps, patch);
  }

  /** `GET /notifications`: the newest first, with each channel's delivery. */
  async list(q: NotificationsQuery): Promise<Result<NotificationsPage>> {
    const page = await listNotifications(this.#deps.db, {
      ...(q.cursor === undefined ? {} : { before: q.cursor }),
      limit: q.limit,
    });
    if (!page.ok) return page;
    return parseAs(
      NotificationsPage,
      {
        // The view's schema keeps its own fields: the seq and the dedupe key stay here.
        items: page.value.items,
        next_cursor: page.value.next,
      },
      "notifications",
    );
  }
}
