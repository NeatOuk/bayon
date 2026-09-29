import {
  destinationChangedNotification,
  notifyLink,
  type Clock,
  type NotifyConfigPatch,
  type Result,
} from "@bayon/core";
import { getNotifyConfig, type Db } from "@bayon/db";
import {
  insertNotifications,
  putNotifyConfig,
  type NotifyConfigChange,
} from "@bayon/db/api";
import { NotifyConfigView } from "@bayon/proto";
import { parseAs } from "../dto.js";
import type { ChannelSet } from "./channels/index.js";
import { deliveriesFor } from "./collect.js";
import type { NotifyLogger } from "./deliver.js";
import { loadNotifySettings } from "./settings.js";

// `GET`/`PUT /notifications/config` (§14): the one API door to the three settings that
// steer where a notification goes and what its link opens. The write, its audit rows and the change
// alert are three steps, and only the first can fail the request:
//
//  1. `putNotifyConfig` writes the settings and one `notify.config` audit row per changed field,
//     naming both values, in one transaction. A field already at its value writes nothing.
//  2. Each change is filed in the outbox, so it goes out on the channels that are on — the operator
//     learns from Bayon that Bayon's destinations moved.
//  3. A changed `email_to` is also sent **straight to the address it replaced**, with a one-message
//     `to` override, so a bearer holder cannot redirect the mail quietly: the mailbox losing it is
//     told by the very channel being redirected, whatever the subscription and quiet hours say.
//
// Steps 2 and 3 are announcements, not the change: neither can undo a written setting, so a failure
// there is logged and the PUT still answers what it wrote.

const OPERATOR = "operator";

export interface NotifyConfigDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly channels: ChannelSet;
  readonly logger: NotifyLogger;
}

/** `GET /notifications/config`: the three as they stand, "" unset. */
export async function readNotifyConfig(
  db: Db,
): Promise<Result<NotifyConfigView>> {
  const values = await getNotifyConfig(db);
  if (!values.ok) return values;
  return parseAs(NotifyConfigView, values.value, "notification destinations");
}

/** Every change in the outbox, on whichever channels are on and subscribed. */
async function fileAlerts(
  deps: NotifyConfigDeps,
  changes: readonly NotifyConfigChange[],
): Promise<void> {
  const { settings } = await loadNotifySettings(deps.db);
  const items = changes.map((c) => {
    const notification = destinationChangedNotification(c);
    return {
      notification,
      deliveries: deliveriesFor(notification.event_kind, settings),
    };
  });
  const filed = await insertNotifications(deps.db, { items, cursors: {} });
  if (!filed.ok) {
    deps.logger.error(
      `notify: a destination change could not be filed: ${filed.error.message}`,
    );
  }
}

/** The address a changed `email_to` replaced, told directly. Nothing to tell when it was unset. */
async function tellPreviousRecipient(
  deps: NotifyConfigDeps,
  change: NotifyConfigChange,
): Promise<void> {
  if (change.field !== "email_to" || change.from === "") return;
  const { settings } = await loadNotifySettings(deps.db);
  const alert = destinationChangedNotification(change);
  const sent = await deps.channels.email.send({
    title: alert.title,
    body: alert.body,
    link: notifyLink(settings.baseUrl, alert.link_path),
    to: change.from,
  });
  if (!sent.ok) {
    deps.logger.warn(
      `notify: the previous email recipient could not be told of the change: ${sent.error.message}`,
    );
  }
}

/**
 * `PUT /notifications/config`. A refused field or value is `validation` and writes nothing at all;
 * a value the setting already has writes nothing and announces nothing.
 */
export async function writeNotifyConfig(
  deps: NotifyConfigDeps,
  patch: NotifyConfigPatch,
): Promise<Result<NotifyConfigView>> {
  const written = await putNotifyConfig(deps.db, patch, OPERATOR);
  if (!written.ok) return written;
  if (written.value.length > 0) {
    await fileAlerts(deps, written.value);
    for (const change of written.value)
      await tellPreviousRecipient(deps, change);
  }
  return readNotifyConfig(deps.db);
}
