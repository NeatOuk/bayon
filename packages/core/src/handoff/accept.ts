import { z } from "zod";
import {
  HOLDING_ROLES,
  UNHELD_STATUSES,
  type HoldingTicket,
} from "./quality.js";

// handoff_accept's law (§7.3; plan rule 3). Pure: the API's writer decides it
// inside its transaction, over the rows it read there, and its compare-and-set on the one pending
// predicate is the guard. Accepting moves tickets.owner_session_id, never the ticket's status.

/** Why an accept is refused; each is one of the closed MCP refusal reasons. */
export const AcceptRefusalReason = z.enum([
  "not_found",
  "cross_ticket_write",
  "actor_not_allowed",
  /** The row is still being written, or another session accepted it. */
  "not_pending",
  /** Nothing to claim: the ticket is owned, closed, or has a pending hand-off to accept instead. */
  "not_claimable",
]);
export type AcceptRefusalReason = z.infer<typeof AcceptRefusalReason>;

export interface AcceptSession {
  readonly id: string;
  readonly role: string;
  readonly ticket_id: string | null;
  /** The hand-off this session was spawned to take over (M2-c), if any. */
  readonly handoff_in_id: string | null;
}

export interface AcceptRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly quality: string;
  readonly accepted_at: number | null;
  readonly to_session_id: string | null;
}

export interface AcceptFacts {
  readonly session: AcceptSession;
  /**
   * The id the call named (a packet label already resolved on the session's ticket, else as
   * given); null takes the session's own hand-off, or else claims its ticket.
   */
  readonly requested: string | null;
  /** The row `requested ?? session.handoff_in_id` names; null when none does. */
  readonly row: AcceptRow | null;
  /** The session's ticket; null when it has none. */
  readonly ticket: HoldingTicket | null;
  /** The ticket's pending hand-off (wherePendingHandoff), which a claim must not skip. */
  readonly pending: string | null;
}

export type AcceptDecision =
  | {
      readonly kind: "accept";
      readonly handoffId: string;
      readonly ticketId: string;
    }
  /** No hand-off to take: the session becomes the owner of its unowned ticket. */
  | { readonly kind: "claim"; readonly ticketId: string }
  /** A repeat by the session that already accepted or claimed: nothing is written again. */
  | {
      readonly kind: "already";
      readonly handoffId: string | null;
      readonly ticketId: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: AcceptRefusalReason;
      readonly detail: string;
    };

const refused = (
  reason: AcceptRefusalReason,
  detail: string,
): AcceptDecision => ({ kind: "refused", reason, detail });

const LABEL = /^handoff-([1-9][0-9]{0,8})$/;

/** A packet label's number (`handoff-3` → 3), as the packet header shows it; null for anything else. */
export const handoffLabelNumber = (ref: string): number | null => {
  const n = LABEL.exec(ref)?.[1];
  return n === undefined ? null : Number(n);
};

/** The call that works for this session, so a refusal names it. */
const nextCall = (s: AcceptSession): string =>
  s.handoff_in_id === null
    ? "call handoff_accept with no arguments, or name a hand-off on your ticket by its id or its packet label (handoff-<n>)"
    : `you were handed ${s.handoff_in_id}: call handoff_accept with no arguments`;

/** What handoff_accept does for `f.session`: accept a row, claim the ticket, repeat, or refuse. */
export function decideAccept(f: AcceptFacts): AcceptDecision {
  const id = f.requested ?? f.session.handoff_in_id;
  return id === null ? decideClaim(f) : decideRow(f, id);
}

function decideRow(f: AcceptFacts, id: string): AcceptDecision {
  const { session, row } = f;
  if (row === null) {
    const where = handoffLabelNumber(id) === null ? "" : " on your ticket";
    return refused(
      "not_found",
      `no hand-off ${id}${where}; ${nextCall(session)}`,
    );
  }
  if (session.handoff_in_id !== null && session.handoff_in_id !== id) {
    return refused(
      "actor_not_allowed",
      `this session takes over hand-off ${session.handoff_in_id}, not ${id}; ${nextCall(session)}`,
    );
  }
  if (row.ticket_id !== session.ticket_id) {
    return refused(
      "cross_ticket_write",
      `hand-off ${id} is for ticket ${row.ticket_id}, not this session's; ${nextCall(session)}`,
    );
  }
  if (row.accepted_at !== null) {
    return row.to_session_id === session.id
      ? { kind: "already", handoffId: id, ticketId: row.ticket_id }
      : refused(
          "not_pending",
          `hand-off ${id} was accepted by session ${row.to_session_id ?? "?"}`,
        );
  }
  if (row.quality === "writing") {
    return refused("not_pending", `hand-off ${id} is still being written`);
  }
  return { kind: "accept", handoffId: id, ticketId: row.ticket_id };
}

function decideClaim(f: AcceptFacts): AcceptDecision {
  const { session, ticket } = f;
  if (ticket === null) {
    return refused("not_found", "this session holds no ticket");
  }
  if (ticket.owner_session_id === session.id) {
    return { kind: "already", handoffId: null, ticketId: ticket.id };
  }
  if (!HOLDING_ROLES.includes(session.role)) {
    return refused(
      "actor_not_allowed",
      `a ${session.role} session never owns a ticket`,
    );
  }
  if (UNHELD_STATUSES.includes(ticket.status)) {
    return refused("not_claimable", `ticket ${ticket.id} is ${ticket.status}`);
  }
  if (ticket.owner_session_id !== null) {
    return refused(
      "not_claimable",
      `ticket ${ticket.id} is owned by session ${ticket.owner_session_id}`,
    );
  }
  if (f.pending !== null) {
    return refused(
      "not_claimable",
      `ticket ${ticket.id} has a pending hand-off: accept ${f.pending}`,
    );
  }
  return { kind: "claim", ticketId: ticket.id };
}
