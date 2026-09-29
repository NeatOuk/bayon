import { ok } from "@bayon/core";
import { all, first, qb, read, type Db, type R } from "../connection.js";
import { orNotFound } from "../errors.js";
import { attentionAt } from "./attention.js";
import type {
  FindingRow,
  GateRow,
  HandoffRow,
  NeedsAttentionRow,
  TicketEconomicsRow,
} from "../schema-work.js";

// Reads for the attention strip and the ticket detail (§4.1, §12): the two 003 views, and a
// ticket's gates, findings and hand-offs. Their writers come in later milestones.

/**
 * v_needs_attention (amendment 4) at the Db's clock, by why then ref. Its ages run on that clock,
 * the one the caller injected, not SQLite's own (044).
 */
export function listNeedsAttention(db: Db): R<NeedsAttentionRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom(attentionAt(ix.clock.now()).as("v"))
        .selectAll()
        .orderBy("why")
        .orderBy("ref")
        .orderBy("ticket_id"),
    ),
  );
}

/** One ticket's row of v_ticket_economics: its derived cost, waste, rounds and hand-offs. */
export async function getTicketEconomics(
  db: Db,
  ticketId: string,
): R<TicketEconomicsRow> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("v_ticket_economics")
        .selectAll()
        .where("id", "=", ticketId),
    ),
  );
  return orNotFound(found, `ticket ${ticketId}`);
}

/** v_ticket_economics' review rounds for a page of tickets (the board's cards), by ticket id. */
export async function listTicketReviewRounds(
  db: Db,
  ticketIds: readonly string[],
): R<ReadonlyMap<string, number>> {
  if (ticketIds.length === 0) return ok(new Map());
  const rows = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("v_ticket_economics")
        .select(["id", "review_rounds"])
        .where("id", "in", [...ticketIds]),
    ),
  );
  return rows.ok
    ? ok(new Map(rows.value.map((row) => [row.id, row.review_rounds])))
    : rows;
}

/** A ticket's gates, by kind then attempt. */
export function listTicketGates(db: Db, ticketId: string): R<GateRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("gates")
        .selectAll()
        .where("ticket_id", "=", ticketId)
        .orderBy("kind")
        .orderBy("attempt")
        .orderBy("id"),
    ),
  );
}

/** The findings on a ticket's gates, oldest first. */
export function listTicketFindings(db: Db, ticketId: string): R<FindingRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("findings")
        .innerJoin("gates", "gates.id", "findings.gate_id")
        .selectAll("findings")
        .where("gates.ticket_id", "=", ticketId)
        .orderBy("findings.created_at")
        .orderBy("findings.id"),
    ),
  );
}

/** A ticket's hand-off packets, oldest first. */
export function listTicketHandoffs(db: Db, ticketId: string): R<HandoffRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("handoffs")
        .selectAll()
        .where("ticket_id", "=", ticketId)
        .orderBy("created_at")
        .orderBy("id"),
    ),
  );
}
