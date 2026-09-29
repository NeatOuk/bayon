import {
  NOTIFY_ERROR_MAX,
  NewNotification,
  NotifyChannel,
  capText,
  err,
  newId,
  ok,
  type Result,
} from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import {
  all,
  execute,
  first,
  qb,
  read,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type {
  NotificationDeliveryRow,
  NotificationRow,
} from "../schema-notify.js";
import { NOTIFY_SOURCES, type NotifySource } from "./notify-sources.js";

// The notifier's outbox (§9.5 amendment: API-written). A tick files what it found and
// moves its watermarks in one transaction, so a crash between the two can neither lose a moment nor
// file it twice; `dedupe_key` is UNIQUE, so a restart that finds the same moment again files
// nothing. Each delivery is claimed (an attempt counted, its retry time set) before it is sent and
// settled after: delivery is at-least-once, the outbox exactly-once. Every stored error was
// scrubbed by the API before it got here, and is capped here.
//
// A key that comes back is not always the same moment word for word: a grouped
// attention moment can grow within its UTC day, from one question waiting on a ticket to three. The
// key deliberately ignores the count, so the second filing must not notify again — but while
// nothing has reached the operator, the text can be corrected in place so what goes out says three.
// "Reached the operator" is a delivery `sent` or `failed`: a `skipped` one never leaves this
// process — a channel that is off is marked skipped at filing — so it does not block the
// correction. Once one has been sent or failed, the row keeps the text that went; the next day's
// key carries the newer count.

const Channel = NotifyChannel;
const FilingDelivery = z.object({
  channel: Channel,
  state: z.enum(["pending", "skipped"]),
  /** Why a skipped row was skipped: `disabled`, `not subscribed`. */
  last_error: z.string().nullable(),
});
const Filing = z.object({
  notification: NewNotification,
  deliveries: z.array(FilingDelivery),
});
const Cursor = z.int().nonnegative();
export const NotifyFilingInput = z.object({
  items: z.array(Filing),
  cursors: z.partialRecord(z.enum(NOTIFY_SOURCES), Cursor),
});
export type NotifyFiling = z.infer<typeof NotifyFilingInput>;

export interface NotifyFiled {
  /** The ids of the notifications this call inserted; a key already filed is not among them. */
  readonly created: readonly string[];
  /**
   * The ids whose title and body this call corrected in place, because the key was filed, the text
   * had moved on and no delivery had gone out yet. No new notification, no new delivery.
   */
  readonly refreshed: readonly string[];
}

const invalid = (what: string, e: z.ZodError) =>
  err(failure("validation", `${what}: ${z.prettifyError(e)}`));

const cappedError = (text: string | null): string | null =>
  text === null ? null : capText(text, NOTIFY_ERROR_MAX);

/** One notification as this call left it: newly filed, or corrected in place. */
interface FiledOne {
  readonly id: string;
  readonly created: boolean;
}

/** The states that mean a delivery reached the operator, or tried to: the text is then its own. */
const WENT_OUT = ["sent", "failed"] as const;

/** Whether nothing of this notification has gone out: every delivery is still pending or skipped. */
function untouched(ix: Internals, notificationId: string): boolean {
  return (
    first(
      ix,
      qb
        .selectFrom("notification_deliveries")
        .select("channel")
        .where("notification_id", "=", notificationId)
        .where("state", "in", WENT_OUT)
        .limit(1),
    ) === undefined
  );
}

/**
 * The key is filed already. When the moment has since grown and no delivery has been sent or
 * failed, the text is corrected in place — the key never moves, so nobody is notified twice.
 */
function refreshOne(
  ix: Internals,
  n: z.infer<typeof Filing>["notification"],
): FiledOne | null {
  const row = first(
    ix,
    qb
      .selectFrom("notifications")
      .select(["id", "title", "body"])
      .where("dedupe_key", "=", n.dedupe_key),
  );
  if (row === undefined) return null;
  if (row.title === n.title && row.body === n.body) return null;
  if (!untouched(ix, row.id)) return null;
  execute(
    ix,
    qb
      .updateTable("notifications")
      .set({ title: n.title, body: n.body })
      .where("id", "=", row.id),
  );
  return { id: row.id, created: false };
}

function fileOne(ix: Internals, f: z.infer<typeof Filing>): FiledOne | null {
  const now = ix.clock.now();
  const inserted = first(
    ix,
    qb
      .insertInto("notifications")
      .values({ id: newId(now), ...f.notification, created_at: now })
      .onConflict((oc) => oc.column("dedupe_key").doNothing())
      .returning("id"),
  );
  if (inserted === undefined) return refreshOne(ix, f.notification);
  const channels = new Set<string>();
  for (const d of f.deliveries) {
    if (channels.has(d.channel)) continue;
    channels.add(d.channel);
    execute(
      ix,
      qb.insertInto("notification_deliveries").values({
        notification_id: inserted.id,
        channel: d.channel,
        state: d.state,
        last_error: cappedError(d.last_error),
        next_attempt_at: d.state === "pending" ? now : null,
      }),
    );
  }
  return { id: inserted.id, created: true };
}

function moveCursor(ix: Internals, source: NotifySource, lastSeen: number) {
  const now = ix.clock.now();
  execute(
    ix,
    qb
      .insertInto("notification_cursors")
      .values({ source, last_seen: lastSeen, updated_at: now })
      .onConflict((oc) =>
        oc
          .column("source")
          .doUpdateSet({ last_seen: lastSeen, updated_at: now }),
      ),
  );
}

/**
 * Files each notification whose key is new, with its delivery rows, corrects the text of one whose
 * key is filed but whose moment has grown and not yet gone out, and moves the watermarks.
 */
export async function insertNotifications(
  db: Db,
  filing: NotifyFiling,
): R<NotifyFiled> {
  const parsed = NotifyFilingInput.safeParse(filing);
  if (!parsed.success) return invalid("notifications", parsed.error);
  const { items, cursors } = parsed.data;
  return write(db, (ix) => {
    const created: string[] = [];
    const refreshed: string[] = [];
    for (const f of items) {
      const filed = fileOne(ix, f);
      if (filed === null) continue;
      (filed.created ? created : refreshed).push(filed.id);
    }
    for (const source of NOTIFY_SOURCES) {
      const at = cursors[source];
      if (at !== undefined) moveCursor(ix, source, at);
    }
    return ok({ created, refreshed });
  });
}

const DeliveryKey = z.object({
  notification_id: z.string().min(1),
  channel: Channel,
});
type DeliveryKey = z.infer<typeof DeliveryKey>;
const Moment = z.int().nonnegative();

/** A pending delivery's row, or not_found (gone) / conflict (no longer pending). */
function pendingOnly(ix: Internals, k: DeliveryKey): Result<void> {
  const row = first(
    ix,
    qb
      .selectFrom("notification_deliveries")
      .select("state")
      .where("notification_id", "=", k.notification_id)
      .where("channel", "=", k.channel),
  );
  if (row === undefined)
    return err(
      failure("not_found", `delivery ${k.notification_id}/${k.channel}`),
    );
  return row.state === "pending"
    ? ok(undefined)
    : err(
        failure(
          "conflict",
          `delivery ${k.notification_id}/${k.channel} is ${row.state}, not pending`,
        ),
      );
}

const Claim = DeliveryKey.extend({ retry_at: Moment });

/**
 * Before a send: one attempt counted, stamped now, and `next_attempt_at` set to when it is due again
 * should the process die mid-send. Returns the attempts made, this one included.
 */
export async function claimDelivery(
  db: Db,
  claim: z.infer<typeof Claim>,
): R<{ readonly attempts: number }> {
  const parsed = Claim.safeParse(claim);
  if (!parsed.success) return invalid("claim", parsed.error);
  const c = parsed.data;
  return write(db, (ix) => {
    const pending = pendingOnly(ix, c);
    if (!pending.ok) return pending;
    const row = first(
      ix,
      qb
        .updateTable("notification_deliveries")
        .set({
          attempts: sql<number>`attempts + 1`,
          last_attempt_at: ix.clock.now(),
          next_attempt_at: c.retry_at,
        })
        .where("notification_id", "=", c.notification_id)
        .where("channel", "=", c.channel)
        .returning("attempts"),
    );
    return row === undefined
      ? err(failure("internal", "the claimed delivery returned no row"))
      : ok({ attempts: row.attempts });
  });
}

export const DeliveryOutcome = z.discriminatedUnion("state", [
  z.object({ state: z.literal("sent") }),
  z.object({
    state: z.literal("pending"),
    next_attempt_at: Moment,
    error: z.string(),
  }),
  z.object({ state: z.literal("failed"), error: z.string() }),
  z.object({ state: z.literal("skipped"), error: z.string() }),
]);
export type DeliveryOutcome = z.infer<typeof DeliveryOutcome>;
const Settle = DeliveryKey.extend({ outcome: DeliveryOutcome });

/** After a send (or a check that skips it): the row's state, its error scrubbed and capped. */
export async function settleDelivery(
  db: Db,
  settle: z.infer<typeof Settle>,
): R<void> {
  const parsed = Settle.safeParse(settle);
  if (!parsed.success) return invalid("settle", parsed.error);
  const { outcome, ...k } = parsed.data;
  return write(db, (ix) => {
    const pending = pendingOnly(ix, k);
    if (!pending.ok) return pending;
    const now = ix.clock.now();
    execute(
      ix,
      qb
        .updateTable("notification_deliveries")
        .set(
          outcome.state === "sent"
            ? {
                state: "sent",
                sent_at: now,
                last_error: null,
                next_attempt_at: null,
              }
            : {
                state: outcome.state,
                last_error: cappedError(outcome.error),
                next_attempt_at:
                  outcome.state === "pending" ? outcome.next_attempt_at : null,
              },
        )
        .where("notification_id", "=", k.notification_id)
        .where("channel", "=", k.channel),
    );
    return ok(undefined);
  });
}

const Defer = DeliveryKey.extend({ until: Moment });

/** Quiet hours: a pending delivery waits until `until`, spending no attempt. */
export async function deferDelivery(
  db: Db,
  defer: z.infer<typeof Defer>,
): R<void> {
  const parsed = Defer.safeParse(defer);
  if (!parsed.success) return invalid("defer", parsed.error);
  const d = parsed.data;
  return write(db, (ix) => {
    const pending = pendingOnly(ix, d);
    if (!pending.ok) return pending;
    execute(
      ix,
      qb
        .updateTable("notification_deliveries")
        .set({ next_attempt_at: d.until })
        .where("notification_id", "=", d.notification_id)
        .where("channel", "=", d.channel),
    );
    return ok(undefined);
  });
}

/** A pending delivery that is due, with what it sends. */
export interface DueDelivery {
  readonly notification_id: string;
  readonly channel: string;
  readonly attempts: number;
  readonly event_kind: string;
  readonly title: string;
  readonly body: string;
  readonly link_path: string | null;
}

/** Pending deliveries due at `now`, the longest waiting first. */
export async function dueDeliveries(
  db: Db,
  now: number,
  limit: number,
): R<DueDelivery[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("notification_deliveries as d")
        .innerJoin("notifications as n", "n.id", "d.notification_id")
        .select([
          "d.notification_id",
          "d.channel",
          "d.attempts",
          "n.event_kind",
          "n.title",
          "n.body",
          "n.link_path",
        ])
        .where("d.state", "=", "pending")
        .where((eb) =>
          eb.or([
            eb("d.next_attempt_at", "is", null),
            eb("d.next_attempt_at", "<=", now),
          ]),
        )
        .orderBy(sql`coalesce(d.next_attempt_at, 0)`)
        .orderBy(sql`n.rowid`)
        .limit(limit),
    ),
  );
}

export interface NotificationWithDeliveries extends NotificationRow {
  /** The row's place in the outbox: what a page's cursor names. */
  readonly seq: number;
  readonly deliveries: readonly NotificationDeliveryRow[];
}

export interface NotificationsPageRows {
  readonly items: readonly NotificationWithDeliveries[];
  /** The `before` of the next page; null on the last. */
  readonly next: number | null;
}

/** The newest notifications before `before` (a seq), with their deliveries. */
export async function listNotifications(
  db: Db,
  q: { readonly before?: number; readonly limit: number },
): R<NotificationsPageRows> {
  return read(db, (ix) => {
    const rows = all(
      ix,
      qb
        .selectFrom("notifications")
        .selectAll()
        .select(sql<number>`rowid`.as("seq"))
        .$if(q.before !== undefined, (b) =>
          b.where(sql<number>`rowid`, "<", q.before ?? 0),
        )
        .orderBy(sql`rowid`, "desc")
        .limit(q.limit + 1),
    );
    const page = rows.slice(0, q.limit);
    const ids = page.map((r) => r.id);
    const deliveries =
      ids.length === 0
        ? []
        : all(
            ix,
            qb
              .selectFrom("notification_deliveries")
              .selectAll()
              .where("notification_id", "in", ids)
              .orderBy("channel"),
          );
    const items = page.map((r) => ({
      ...r,
      deliveries: deliveries.filter((d) => d.notification_id === r.id),
    }));
    return {
      items,
      next: rows.length > q.limit ? (page.at(-1)?.seq ?? null) : null,
    };
  });
}

export interface ChannelStat {
  readonly channel: string;
  readonly last_sent_at: number | null;
  /** The newest attempt's error, when it came after the last send. */
  readonly last_error: string | null;
}

/** Each channel's last send, and its newest error since. */
export async function notifyChannelStats(db: Db): R<ChannelStat[]> {
  return read(db, (ix) => {
    const sent = all(
      ix,
      qb
        .selectFrom("notification_deliveries")
        .select([
          "channel",
          sql<number | null>`max(sent_at)`.as("last_sent_at"),
        ])
        .groupBy("channel"),
    );
    return NotifyChannel.options.map((channel) => {
      const lastSent =
        sent.find((s) => s.channel === channel)?.last_sent_at ?? null;
      const failing = first(
        ix,
        qb
          .selectFrom("notification_deliveries")
          .select("last_error")
          .where("channel", "=", channel)
          .where("state", "in", ["pending", "failed"])
          .where("last_error", "is not", null)
          .where("last_attempt_at", ">", lastSent ?? -1)
          .orderBy("last_attempt_at", "desc")
          .limit(1),
      );
      return {
        channel,
        last_sent_at: lastSent,
        last_error: failing?.last_error ?? null,
      };
    });
  });
}
