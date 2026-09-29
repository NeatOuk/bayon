import { err, newId, ok, openQuestionKey, type Result } from "@bayon/core";
import { z } from "zod";
import { requireText } from "../checks.js";
import {
  all,
  first,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type R,
} from "../connection.js";
import { failure, orNotFound } from "../errors.js";
import { optionalJson } from "../json.js";
import type { HumanRequestRow, MessageRow } from "../schema-work.js";
import { audited, type AuditEntry } from "./audit.js";
import { questionDigest, raiseNeedsHumanIn } from "./open-questions.js";
import type { TicketActor } from "./ticket-common.js";

// The mailbox and human requests (§11.1). The writers are the API's (§9.5), for REST and MCP.

export interface NewMessage {
  readonly from_kind: string;
  readonly from_id: string;
  readonly to_kind: string;
  readonly to_id: string;
  readonly kind: string;
  readonly subject: string;
  readonly body_md: string;
  readonly ticket_id?: string;
  readonly correlation_id?: string;
  readonly requires_ack?: boolean;
}

/** Sends a message, stamped now. Delivery, reading and acking are later writes. */
export async function sendMessage(
  db: Db,
  m: NewMessage,
  /** An MCP write's audit entry, committed with the message. */
  audit?: AuditEntry,
): R<MessageRow> {
  const checked = requireText({
    from_kind: m.from_kind,
    from_id: m.from_id,
    to_kind: m.to_kind,
    to_id: m.to_id,
    kind: m.kind,
    subject: m.subject,
  });
  if (!checked.ok) return checked;
  return write(db, (ix) => {
    const now = ix.clock.now();
    const sent = returningOne(
      ix,
      qb
        .insertInto("messages")
        .values({
          id: newId(now),
          ts: now,
          from_kind: m.from_kind,
          from_id: m.from_id,
          to_kind: m.to_kind,
          to_id: m.to_id,
          kind: m.kind,
          subject: m.subject,
          body_md: m.body_md,
          ticket_id: m.ticket_id ?? null,
          correlation_id: m.correlation_id ?? null,
          requires_ack: m.requires_ack === true ? 1 : 0,
        })
        .returningAll(),
    );
    return audited(ix, sent, audit);
  });
}

const InboxQueryShape = z.object({
  to_kind: z.string().min(1),
  to_id: z.string().min(1),
  unread_only: z.boolean().optional(),
  limit: z.int().min(1).max(1000),
});
export type InboxQuery = z.input<typeof InboxQueryShape>;

/** A recipient's messages, oldest first; `unread_only` leaves the read ones out. */
export async function listInbox(db: Db, query: InboxQuery): R<MessageRow[]> {
  const parsed = InboxQueryShape.safeParse(query);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `bad inbox query: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { to_kind, to_id, unread_only, limit } = parsed.data;
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("messages")
        .selectAll()
        .where("to_id", "=", to_id)
        .where("to_kind", "=", to_kind)
        .$if(unread_only === true, (b) => b.where("read_at", "is", null))
        .orderBy("ts")
        .orderBy("id")
        .limit(limit),
    ),
  );
}

const MarkReadShape = z.object({
  to_kind: z.string().min(1),
  to_id: z.string().min(1),
  ids: z.array(z.string().min(1)).max(1000),
});
export type MarkMessagesRead = z.input<typeof MarkReadShape>;

/**
 * Stamps read_at on those of `ids` that are the recipient's and still unread, and returns how many
 * it stamped. Idempotent: a read message keeps its first read_at; another recipient's is untouched.
 * Not audited: it is the read receipt of a read tool (mailbox_inbox), and reads are not audited.
 */
export async function markMessagesRead(db: Db, m: MarkMessagesRead): R<number> {
  const parsed = MarkReadShape.safeParse(m);
  if (!parsed.success) {
    return err(
      failure("validation", `bad read mark: ${z.prettifyError(parsed.error)}`),
    );
  }
  const { to_kind, to_id, ids } = parsed.data;
  if (ids.length === 0) return ok(0);
  return write(db, (ix) => {
    const stamped = all(
      ix,
      qb
        .updateTable("messages")
        .set({ read_at: ix.clock.now() })
        .where("id", "in", ids)
        .where("to_id", "=", to_id)
        .where("to_kind", "=", to_kind)
        .where("read_at", "is", null)
        .returning("id"),
    );
    return ok(stamped.length);
  });
}

export interface NewHumanRequest {
  readonly session_id?: string;
  readonly ticket_id?: string;
  readonly kind: string;
  readonly question: string;
  readonly context_md?: string;
  /** Choices to offer, as JSON. */
  readonly options?: unknown;
  readonly batch_id?: string;
  readonly expires_at?: number;
}

/**
 * Opens a human request and returns at once: `human.ask` never blocks, and never changes the
 * asking session's state (§11.1, contract 5).
 */
export async function insertHumanRequest(
  db: Db,
  h: NewHumanRequest,
): R<HumanRequestRow> {
  const checked = requireText({ kind: h.kind, question: h.question });
  if (!checked.ok) return checked;
  const options = optionalJson(h.options, "options");
  if (!options.ok) return options;
  return write(db, (ix) => {
    const now = ix.clock.now();
    return returningOne(
      ix,
      qb
        .insertInto("human_requests")
        .values({
          id: newId(now),
          session_id: h.session_id ?? null,
          ticket_id: h.ticket_id ?? null,
          kind: h.kind,
          question: h.question,
          context_md: h.context_md ?? null,
          options_json: options.value,
          batch_id: h.batch_id ?? null,
          status: "open",
          asked_at: now,
          expires_at: h.expires_at ?? null,
        })
        .returningAll(),
    );
  });
}

/** A human_ask batch as written: each request new, or the open one it repeats. */
export interface AskedHumanRequests {
  /** The batch's requests, in its order. */
  readonly rows: HumanRequestRow[];
  /** The ids among them that were already open: the same question, still unanswered, on the ticket. */
  readonly reused: readonly string[];
}

/** The requests' checks, and each one's options as JSON text. */
function checkBatch(
  batch: readonly NewHumanRequest[],
): Result<{ readonly h: NewHumanRequest; readonly options: string | null }[]> {
  if (batch.length === 0) {
    return err(failure("validation", "a batch needs at least one request"));
  }
  const checked: {
    readonly h: NewHumanRequest;
    readonly options: string | null;
  }[] = [];
  for (const h of batch) {
    const text = requireText({ kind: h.kind, question: h.question });
    if (!text.ok) return text;
    const options = optionalJson(h.options, "options");
    if (!options.ok) return options;
    checked.push({ h, options: options.value });
  }
  return ok(checked);
}

/**
 * human_ask's batch (§11.1: up to 4; contract 5): every request opens in one transaction under
 * one batch id, with one audit entry. Returns at once and never changes the asking session.
 *
 * the ticket waits instead. Each asked ticket's needs_human is raised (a version bump
 * and an `updated` event, the asker as actor). A question equal, once normalized, to one still open
 * on the same ticket is not asked twice: the open request is returned in its place, and listed in
 * `reused`. Its dedupe key names the status (`ask:<ticket>:<digest>:open`), and the answer rewrites
 * it, so the unique index never refuses the same question once it has been answered.
 */
export async function askHumanRequests(
  db: Db,
  batch: readonly NewHumanRequest[],
  audit?: AuditEntry,
): R<AskedHumanRequests> {
  const checked = checkBatch(batch);
  if (!checked.ok) return checked;
  return write(db, (ix) => {
    const now = ix.clock.now();
    const batchId = newId(now);
    const rows: HumanRequestRow[] = [];
    const reused: string[] = [];
    const asked = new Map<string, TicketActor>();
    for (const { h, options } of checked.value) {
      if (h.ticket_id !== undefined) {
        asked.set(h.ticket_id, {
          actor_kind: "session",
          actor_id: h.session_id ?? null,
          reason: "human_ask",
        });
      }
      const key =
        h.ticket_id === undefined
          ? null
          : openQuestionKey(h.ticket_id, questionDigest(h.question));
      const open =
        key === null
          ? undefined
          : first(
              ix,
              qb
                .selectFrom("human_requests")
                .selectAll()
                .where("dedupe_key", "=", key),
            );
      if (open !== undefined) {
        rows.push(open);
        reused.push(open.id);
        continue;
      }
      const row = returningOne(
        ix,
        qb
          .insertInto("human_requests")
          .values({
            id: newId(now),
            session_id: h.session_id ?? null,
            ticket_id: h.ticket_id ?? null,
            kind: h.kind,
            question: h.question,
            context_md: h.context_md ?? null,
            options_json: options,
            batch_id: batchId,
            status: "open",
            asked_at: now,
            expires_at: h.expires_at ?? null,
            dedupe_key: key,
          })
          .returningAll(),
      );
      if (!row.ok) return row;
      rows.push(row.value);
    }
    for (const [ticketId, by] of asked) raiseNeedsHumanIn(ix, ticketId, by);
    return audited(ix, ok({ rows, reused }), audit);
  });
}

/** askHumanRequests' rows alone: the batch's requests, in order. */
export async function insertHumanRequests(
  db: Db,
  batch: readonly NewHumanRequest[],
  audit?: AuditEntry,
): R<HumanRequestRow[]> {
  const asked = await askHumanRequests(db, batch, audit);
  return asked.ok ? ok(asked.value.rows) : asked;
}

/** A ticket's human requests, newest first: what ticket_get shows of human_ask's answers. */
export function listTicketHumanRequests(
  db: Db,
  ticketId: string,
  limit: number,
): R<HumanRequestRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("human_requests")
        .selectAll()
        .where("ticket_id", "=", ticketId)
        .orderBy("asked_at", "desc")
        .orderBy("id", "desc")
        .limit(limit),
    ),
  );
}

export async function getHumanRequest(db: Db, id: string): R<HumanRequestRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("human_requests").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `human request ${id}`);
}
