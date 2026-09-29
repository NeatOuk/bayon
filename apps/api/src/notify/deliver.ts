import {
  NOTIFY_BACKOFF_MS,
  NOTIFY_MAX_ATTEMPTS,
  NotifyChannel,
  NotifyEventKind,
  isQuiet,
  notifyLink,
  quietEndsAt,
  retryAt,
  subscribes,
  err,
  type Clock,
  type FrmError,
  type Result,
} from "@bayon/core";
import { dueDeliveries, type Db, type DueDelivery } from "@bayon/db";
import {
  claimDelivery,
  deferDelivery,
  settleDelivery,
  type DeliveryOutcome,
} from "@bayon/db/api";
import type { ChannelSender, ChannelSet, Outbound } from "./channels/index.js";
import { SKIP_DISABLED, SKIP_UNSUBSCRIBED } from "./collect.js";
import type { NotifySettings } from "./settings.js";

// Each tick's sends. A due delivery is re-checked against the settings as they stand
// (off or unsubscribed since: skipped), held by quiet hours (every channel but the Mac's, which is
// local and silent under Focus anyway) until the window ends without spending an attempt, claimed —
// its attempt counted and its retry time set before the send, so a crash mid-send retries after the
// backoff rather than at once — then sent and settled: sent; skipped when the channel is not
// configured; pending again at the next backoff while the error is retryable; failed when it is
// not, or the fifth retry is spent.

export const NOTIFY_DELIVERIES_PER_TICK = 20;

export interface NotifyLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface DeliverDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly channels: ChannelSet;
  readonly logger: NotifyLogger;
}

const LAST_BACKOFF = NOTIFY_BACKOFF_MS[NOTIFY_BACKOFF_MS.length - 1] ?? 0;

/** What a send's result makes of the delivery, its `attempts` counting the send just made. */
export function outcomeOf(
  sent: Result<void>,
  attempts: number,
  now: number,
): DeliveryOutcome {
  if (sent.ok) return { state: "sent" };
  const e: FrmError = sent.error;
  if (e.class === "not_found") return { state: "skipped", error: e.message };
  const next = e.retryable ? retryAt(attempts, now) : null;
  return next === null
    ? { state: "failed", error: e.message }
    : { state: "pending", next_attempt_at: next, error: e.message };
}

type Step =
  | { readonly kind: "settle"; readonly outcome: DeliveryOutcome }
  | { readonly kind: "defer"; readonly until: number }
  | { readonly kind: "send" };

/** What to do with a due row before any send: skip, hold, or go. */
function stepOf(
  channel: NotifyChannel,
  kind: NotifyEventKind,
  attempts: number,
  settings: NotifySettings,
  now: number,
): Step {
  const c = settings.channels[channel];
  if (!c.enabled)
    return {
      kind: "settle",
      outcome: { state: "skipped", error: SKIP_DISABLED },
    };
  if (!subscribes(c.events, kind))
    return {
      kind: "settle",
      outcome: { state: "skipped", error: SKIP_UNSUBSCRIBED },
    };
  if (attempts >= NOTIFY_MAX_ATTEMPTS)
    return {
      kind: "settle",
      outcome: { state: "failed", error: "its retries were spent" },
    };
  if (channel !== "mac" && isQuiet(now, settings.quiet))
    return { kind: "defer", until: quietEndsAt(now, settings.quiet) };
  return { kind: "send" };
}

/** A channel that throws is a retryable failure, never a crashed tick. Its message is not kept. */
async function sendGuarded(
  sender: ChannelSender,
  o: Outbound,
  signal: AbortSignal | undefined,
): Promise<Result<void>> {
  try {
    return await sender.send(o, signal);
  } catch {
    return err({
      class: "internal",
      message: `the ${sender.channel} channel failed unexpectedly`,
      retryable: true,
    });
  }
}

function logged(
  deps: DeliverDeps,
  what: string,
  written: Result<unknown>,
): void {
  if (!written.ok)
    deps.logger.error(`notify: ${what}: ${written.error.message}`);
}

async function deliverOne(
  deps: DeliverDeps,
  row: DueDelivery,
  settings: NotifySettings,
  signal: AbortSignal | undefined,
): Promise<void> {
  const what = `${row.channel} delivery of ${row.notification_id}`;
  const channel = NotifyChannel.safeParse(row.channel);
  const kind = NotifyEventKind.safeParse(row.event_kind);
  if (!channel.success || !kind.success) {
    // The writer's schema lets neither in: a row some other door wrote. Left alone, and said.
    deps.logger.error(
      `notify: ${what} names an unknown channel or event kind (${row.event_kind})`,
    );
    return;
  }
  const key = { notification_id: row.notification_id, channel: channel.data };
  const now = deps.clock.now();
  const step = stepOf(channel.data, kind.data, row.attempts, settings, now);
  if (step.kind === "settle") {
    logged(
      deps,
      `settle ${what}`,
      await settleDelivery(deps.db, { ...key, outcome: step.outcome }),
    );
    return;
  }
  if (step.kind === "defer") {
    logged(
      deps,
      `defer ${what}`,
      await deferDelivery(deps.db, { ...key, until: step.until }),
    );
    return;
  }
  const claimed = await claimDelivery(deps.db, {
    ...key,
    retry_at: retryAt(row.attempts + 1, now) ?? now + LAST_BACKOFF,
  });
  if (!claimed.ok) {
    logged(deps, `claim ${what}`, claimed);
    return;
  }
  const sent = await sendGuarded(
    deps.channels[channel.data],
    {
      title: row.title,
      body: row.body,
      link: notifyLink(settings.baseUrl, row.link_path),
    },
    signal,
  );
  const attempts = claimed.value.attempts;
  const outcome = outcomeOf(sent, attempts, deps.clock.now());
  if (outcome.state === "pending" || outcome.state === "failed")
    deps.logger.warn(
      `notify: ${what} (attempt ${attempts}) ${outcome.state === "failed" ? "failed" : "will be retried"}: ${outcome.error}`,
    );
  logged(
    deps,
    `settle ${what}`,
    await settleDelivery(deps.db, { ...key, outcome }),
  );
}

/** Sends what is due now, at most NOTIFY_DELIVERIES_PER_TICK, one at a time. */
export async function deliverDue(
  deps: DeliverDeps,
  settings: NotifySettings,
  signal?: AbortSignal,
): Promise<void> {
  const due = await dueDeliveries(
    deps.db,
    deps.clock.now(),
    NOTIFY_DELIVERIES_PER_TICK,
  );
  if (!due.ok) {
    deps.logger.error(
      `notify: the due deliveries are unreadable: ${due.error.message}`,
    );
    return;
  }
  for (const row of due.value) {
    if (signal?.aborted === true) return;
    await deliverOne(deps, row, settings, signal);
  }
}
