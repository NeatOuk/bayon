import { err } from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import { allOk, check, requireText } from "../checks.js";
import {
  all,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { optionalJson, toJsonText } from "../json.js";
import type { TicketEventRow, TicketLinkRow } from "../schema-work.js";
import {
  actorColumns,
  checkActor,
  insertTicketEvent,
  type TicketActor,
} from "./ticket-common.js";
import { audited, type AuditEntry } from "./audit.js";

// A ticket's history and links. Writers (appendTicketEvent, linkTicket) are the API's; the
// reads are @bayon/db's.

/** Kinds that only their own writer records. */
const WRITER_KINDS = new Set([
  "created",
  "updated",
  "transition",
  "linked",
  // The supervisor's hand-off writers audit here (M2 rule 2).
  "handoff",
  // The gate and finding writers: the API's, and the supervisor's decideGate.
  "gate",
  "finding",
]);

export interface NewTicketEvent extends TicketActor {
  readonly ticket_id: string;
  /** e.g. 'comment' or 'note'; never a kind another writer owns. */
  readonly kind: string;
  readonly payload?: unknown;
}

/**
 * Appends a note to a ticket's history. It changes no ticket column, so the version stays;
 * status moves only through transitionTicket, which writes its own event.
 */
export async function appendTicketEvent(
  db: Db,
  e: NewTicketEvent,
  /** An MCP write's audit entry, committed in the same transaction. */
  audit?: AuditEntry,
): R<TicketEventRow> {
  const checked = allOk(
    requireText({ kind: e.kind }),
    check(!WRITER_KINDS.has(e.kind), `${e.kind} events have their own writer`),
    checkActor(e),
  );
  if (!checked.ok) return checked;
  const payload = optionalJson(e.payload, "payload");
  if (!payload.ok) return payload;
  return write(db, (ix) => {
    const event = returningOne(
      ix,
      qb
        .insertInto("ticket_events")
        .values({
          ticket_id: e.ticket_id,
          ts: ix.clock.now(),
          kind: e.kind,
          ...actorColumns(e),
          payload_json: payload.value,
        })
        .returningAll(),
    );
    return audited(ix, event, audit);
  });
}

export interface NewTicketLink {
  readonly ticket_id: string;
  /** e.g. 'blocks', 'relates', 'pr'. */
  readonly kind: string;
  readonly url?: string;
  readonly target_ticket_id?: string;
}

/** Links a ticket to a url or another ticket, with a `linked` event naming the actor, in one transaction. */
export async function linkTicket(
  db: Db,
  link: NewTicketLink,
  by: TicketActor,
  /** An MCP write's audit entry, committed in the same transaction. */
  audit?: AuditEntry,
): R<TicketLinkRow> {
  const checked = allOk(
    requireText({ kind: link.kind }),
    check(
      link.url !== undefined || link.target_ticket_id !== undefined,
      "a link needs a url or a target ticket",
    ),
    check(
      link.target_ticket_id !== link.ticket_id,
      "a ticket cannot link to itself",
    ),
    checkActor(by),
  );
  if (!checked.ok) return checked;
  const payload = toJsonText(
    {
      kind: link.kind,
      ...(link.url === undefined ? {} : { url: link.url }),
      ...(link.target_ticket_id === undefined
        ? {}
        : { target_ticket_id: link.target_ticket_id }),
    },
    "link",
  );
  if (!payload.ok) return payload;
  return write(db, (ix) => {
    const now = ix.clock.now();
    const row = returningOne(
      ix,
      qb
        .insertInto("ticket_links")
        .values({
          ticket_id: link.ticket_id,
          kind: link.kind,
          url: link.url ?? null,
          target_ticket_id: link.target_ticket_id ?? null,
          created_at: now,
        })
        .returningAll(),
    );
    if (!row.ok) return row;
    insertTicketEvent(ix, {
      ticket_id: link.ticket_id,
      ts: now,
      kind: "linked",
      ...actorColumns(by),
      payload_json: payload.value,
    });
    return audited(ix, row, audit);
  });
}

const TicketEventsQueryShape = z.object({
  /** One ticket's events; every ticket's when absent (the `tickets` WS topic). */
  ticket_id: z.string().min(1).optional(),
  /** Exclusive cursor: a ticket_events.id. */
  since: z.int().nonnegative(),
  limit: z.int().min(1).max(1000),
});
export type TicketEventsQuery = z.input<typeof TicketEventsQueryShape>;

export interface TicketEventsPage {
  readonly rows: TicketEventRow[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

/** A page of ticket events after the exclusive cursor `since`, in id order. */
export async function listTicketEvents(
  db: Db,
  query: TicketEventsQuery,
): R<TicketEventsPage> {
  const parsed = TicketEventsQueryShape.safeParse(query);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `bad ticket events query: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { ticket_id, since, limit } = parsed.data;
  return read(db, (ix) => {
    const rows = all(
      ix,
      qb
        .selectFrom("ticket_events")
        .selectAll()
        .where("id", ">", since)
        .$if(ticket_id !== undefined, (b) =>
          b.where("ticket_id", "=", ticket_id ?? ""),
        )
        .orderBy("id")
        .limit(limit + 1),
    );
    const page = rows.slice(0, limit);
    return {
      rows: page,
      nextCursor: page.at(-1)?.id ?? since,
      hasMore: rows.length > limit,
    };
  });
}

/** A ticket's links, oldest first. */
export function listTicketLinks(db: Db, ticketId: string): R<TicketLinkRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("ticket_links")
        .selectAll()
        .where("ticket_id", "=", ticketId)
        .orderBy("created_at")
        .orderBy(sql`rowid`),
    ),
  );
}
