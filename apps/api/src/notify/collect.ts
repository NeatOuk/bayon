import {
  NOTIFY_CHANNELS,
  STAFF_APPROVAL_KIND,
  armNotification,
  blockNotification,
  budgetNotification,
  groupArms,
  jiraFailNotification,
  proposalNotification,
  qaHumanNotification,
  questionNotification,
  runnerUpdateNotification,
  subscribes,
  type NewNotification,
  type NotifyEventKind,
} from "@bayon/core";
import type { NotifySourceRows } from "@bayon/db";
import type { NotifyFiling } from "@bayon/db/api";
import type { NotifySettings } from "./settings.js";

// One tick's reads as the filing the outbox writer takes: each moment's notification,
// its delivery rows — pending on every channel that is on and subscribed to its kind, skipped on
// the rest, so turning a channel on later never floods it with old news — and the watermarks.
// Pure: the tick reads, this decides, the writer writes.

export const SKIP_DISABLED = "disabled";
export const SKIP_UNSUBSCRIBED = "not subscribed";

type FilingDelivery = NotifyFiling["items"][number]["deliveries"][number];

/** Each channel's row for a notification of `kind`, as the settings stand now. */
export function deliveriesFor(
  kind: NotifyEventKind,
  settings: NotifySettings,
): FilingDelivery[] {
  return NOTIFY_CHANNELS.map((channel) => {
    const c = settings.channels[channel];
    if (!c.enabled)
      return { channel, state: "skipped", last_error: SKIP_DISABLED };
    return subscribes(c.events, kind)
      ? { channel, state: "pending", last_error: null }
      : { channel, state: "skipped", last_error: SKIP_UNSUBSCRIBED };
  });
}

/** Every notification the rows call for, oldest source first; a block folds in its own request. */
export function notificationsOf(
  rows: NotifySourceRows,
  now: number,
): NewNotification[] {
  const folded = new Set(
    rows.blocks.flatMap((b) => (b.requestId === null ? [] : [b.requestId])),
  );
  return [
    ...rows.requests
      .filter((r) => !folded.has(r.id))
      .map((r) =>
        r.kind === STAFF_APPROVAL_KIND
          ? proposalNotification(r)
          : questionNotification(r),
      ),
    ...rows.blocks.map(blockNotification),
    ...rows.qaHuman.map(qaHumanNotification),
    ...rows.jiraFailures.map(jiraFailNotification),
    ...rows.budgets.map((b) => budgetNotification(b, now)),
    // One moment per (arm, ticket) rather than per row: four unanswered questions on
    // one ticket were four near-identical notifications.
    ...groupArms(rows.arms).map((a) => armNotification(a, now)),
    ...rows.runnerUpdates.map(runnerUpdateNotification),
  ];
}

export function filingOf(
  rows: NotifySourceRows,
  settings: NotifySettings,
  now: number,
): NotifyFiling {
  return {
    items: notificationsOf(rows, now).map((notification) => ({
      notification,
      deliveries: deliveriesFor(notification.event_kind, settings),
    })),
    cursors: rows.advance,
  };
}
