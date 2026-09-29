import {
  decideAccept,
  err,
  handoffLabelNumber,
  ok,
  type AcceptRefusalReason,
  type JsonValue,
  type Result,
} from "@bayon/core";
import type { Updateable } from "kysely";
import {
  all,
  execute,
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { HandoffRow, HandoffsTable } from "../schema-work.js";
import { audited, type AuditEntry } from "./audit.js";
import {
  HANDOFF_ACCEPT_COLUMNS,
  packetNumberOf,
  wherePendingHandoff,
} from "./handoffs.js";
import { insertTicketEvent } from "./ticket-common.js";

// handoff_accept's writer (§7.3; plan rule 3): the API's accept columns and
// tickets.owner_session_id, which nothing else writes, plus the ticket event, in one BEGIN
// IMMEDIATE. The law is core's decideAccept over the rows read in this transaction; the update's
// compare-and-set is the one pending predicate. A hand-off never moves tickets.status, and a
// refusal or a repeat writes nothing.

type AcceptPatch = Pick<
  Updateable<HandoffsTable>,
  (typeof HANDOFF_ACCEPT_COLUMNS)[number]
>;

export interface AcceptHandoffRequest {
  readonly session_id: string;
  /** Absent: the session's own hand-off (handoff_in_id), else a claim of its unowned ticket. */
  readonly handoff_id?: string;
}

export type AcceptOutcome =
  | {
      readonly kind: "accepted";
      readonly ticket_id: string;
      /** The accepted row; null for a claim, which takes no hand-off. */
      readonly handoff: HandoffRow | null;
      /** False for a repeat by the same session: nothing was written. */
      readonly created: boolean;
    }
  | {
      readonly kind: "refused";
      readonly reason: AcceptRefusalReason;
      readonly detail: string;
    };

/**
 * Accepts a pending hand-off for the session (or claims its unowned ticket): the accept columns,
 * the ticket's owner and a `handoff` ticket event commit together, with the caller's audit entry.
 */
export function acceptHandoff(
  db: Db,
  req: AcceptHandoffRequest,
  /** An MCP call's audit entry, committed with an accept that lands. */
  audit?: AuditEntry,
): R<AcceptOutcome> {
  return write(db, (ix) => {
    const outcome = acceptIn(ix, req);
    return !outcome.ok || outcome.value.kind === "refused"
      ? outcome
      : audited(ix, outcome, audit);
  });
}

function acceptIn(
  ix: Internals,
  req: AcceptHandoffRequest,
): Result<AcceptOutcome> {
  const session = first(
    ix,
    qb
      .selectFrom("sessions")
      .select(["id", "role", "ticket_id", "handoff_in_id"])
      .where("id", "=", req.session_id),
  );
  if (session === undefined) {
    return err(
      failure("not_found", `session ${req.session_id} does not exist`),
    );
  }
  const requested = requestedId(ix, req.handoff_id, session.ticket_id);
  const id = requested ?? session.handoff_in_id;
  const row =
    id === null
      ? undefined
      : first(ix, qb.selectFrom("handoffs").selectAll().where("id", "=", id));
  const ticket =
    session.ticket_id === null
      ? undefined
      : first(
          ix,
          qb
            .selectFrom("tickets")
            .select(["id", "status", "owner_session_id"])
            .where("id", "=", session.ticket_id),
        );
  const decision = decideAccept({
    session,
    requested,
    row: row ?? null,
    ticket: ticket ?? null,
    pending: ticket === undefined ? null : pendingOf(ix, ticket.id),
  });
  switch (decision.kind) {
    case "refused":
      return ok(decision);
    case "already":
      return ok({
        kind: "accepted",
        ticket_id: decision.ticketId,
        handoff: decision.handoffId === null ? null : (row ?? null),
        created: false,
      });
    case "claim":
      own(ix, decision.ticketId, session.id, {
        handoff_id: null,
        step: "claim",
      });
      return ok({
        kind: "accepted",
        ticket_id: decision.ticketId,
        handoff: null,
        created: true,
      });
    case "accept":
      return take(ix, session.id, decision.handoffId);
  }
}

/**
 * The row id a call names: a packet label (`handoff-<n>`, as the header shows it) only
 * among the session's own ticket's hand-offs, never another ticket's; any other ref as given.
 * An unmatched label stays as given, and decideAccept refuses it as not_found.
 */
function requestedId(
  ix: Internals,
  ref: string | undefined,
  ticketId: string | null,
): string | null {
  if (ref === undefined) return null;
  const n = handoffLabelNumber(ref);
  if (n === null || ticketId === null) return ref;
  const rows = all(
    ix,
    qb
      .selectFrom("handoffs")
      .select(["id", "packet_path"])
      .where("ticket_id", "=", ticketId),
  );
  return rows.find((r) => packetNumberOf(r) === n)?.id ?? ref;
}

/** The ticket's newest pending hand-off, by the one predicate. */
function pendingOf(ix: Internals, ticketId: string): string | null {
  const row = first(
    ix,
    qb
      .selectFrom("handoffs")
      .select("id")
      .where("ticket_id", "=", ticketId)
      .where(wherePendingHandoff)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc"),
  );
  return row?.id ?? null;
}

function take(
  ix: Internals,
  sessionId: string,
  handoffId: string,
): Result<AcceptOutcome> {
  const patch: AcceptPatch = {
    to_session_id: sessionId,
    accepted_at: ix.clock.now(),
  };
  const taken = first(
    ix,
    qb
      .updateTable("handoffs")
      .set(patch)
      .where("id", "=", handoffId)
      .where(wherePendingHandoff)
      .returningAll(),
  );
  if (taken === undefined) {
    return err(failure("conflict", `hand-off ${handoffId} is not pending`));
  }
  own(ix, taken.ticket_id, sessionId, {
    handoff_id: handoffId,
    step: "accept",
    from_session_id: taken.from_session_id,
  });
  return ok({
    kind: "accepted",
    ticket_id: taken.ticket_id,
    handoff: taken,
    created: true,
  });
}

/** tickets.owner_session_id moves to the session (only here), with its ticket event. */
function own(
  ix: Internals,
  ticketId: string,
  sessionId: string,
  payload: Readonly<Record<string, JsonValue>>,
): void {
  const now = ix.clock.now();
  execute(
    ix,
    qb
      .updateTable("tickets")
      .set({ owner_session_id: sessionId, updated_at: now })
      .where("id", "=", ticketId),
  );
  insertTicketEvent(ix, {
    ticket_id: ticketId,
    ts: now,
    actor_kind: "session",
    actor_id: sessionId,
    kind: "handoff",
    from_status: null,
    to_status: null,
    reason: null,
    payload_json: JSON.stringify(payload),
  });
}
