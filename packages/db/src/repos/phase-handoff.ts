import {
  holdsTicket,
  ok,
  type PhaseBoundary,
  type Result,
  type SessionState,
} from "@bayon/core";
import type { ExpressionBuilder } from "kysely";
import type { DB } from "../schema.js";
import {
  all,
  first,
  qb,
  read,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import type { SessionRow, TicketRow } from "../schema.js";
import { insertCommandIn } from "./commands.js";

// The phase-boundary hand-off (§7.1 row four): a transition that leaves the ticket
// asking for a run class its holder does not carry releases that holder, so the next phase can be
// staffed with no operator write. The API writes `tickets` and *inserts* the command; the
// supervisor claims it and writes `sessions` and `handoffs` (Invariant 5). The precedent is
// exact: transitionTicket already ships `gate.run` commands out of its own transaction.

export const SESSION_HANDOFF = "session.handoff";
export const PHASE_CHANGE = "phase_change";

/** The states a session can hand off from (the supervisor's own `HANDING`). */
const HANDING = ["running", "idle"] as const satisfies readonly SessionState[];

/** The session a phase boundary is judged against: the one holding the ticket as the move lands. */
export interface PhaseHolder {
  readonly session_id: string;
  readonly run_class: string;
}

/**
 * A transition's phase-boundary effect, planned over the ticket's holder by the caller (core's
 * `phaseBoundary` against the **landed** status): the phase it hands on to, or null for no
 * boundary. Pure — every read and every write is this module's.
 */
export type PlanHandoff = (holder: PhaseHolder) => PhaseBoundary | null;

/** The `session.handoff` command a boundary inserted. */
export interface PhaseHandoff {
  readonly session_id: string;
  readonly command_id: string;
  readonly phase_to: string | null;
}

/**
 * `<session>:<version>`: the version the move wrote, so a transition retried at the same version
 * finds its own command and inserts no second one.
 */
export const phaseHandoffKey = (sessionId: string, version: number): string =>
  `${PHASE_CHANGE}:${sessionId}:${version}`;

/** One field of a command's stored payload, by JSON path. */
const payloadField =
  (path: string) => (eb: ExpressionBuilder<DB, "commands">) =>
    eb.fn<string | null>("json_extract", [
      eb.ref("payload_json"),
      eb.val(path),
    ]);

/**
 * Whether a transition ever asked for `sessionId`'s phase-boundary release, under any version.
 *
 * This row is the durable record of the ask, and it is all the supervisor needs to keep one from
 * being lost (HIGH): the release itself is re-derived from the ticket, never read
 * back from here, so nothing has to be kept in step. What it rules out is the reconciler inventing
 * a boundary nobody asked for — a holder whose run class simply never matched its ticket's status
 * (an operator's own session, a worker whose move was refused) is not stranded, and releasing it
 * would end work that is going perfectly well.
 */
export async function askedPhaseHandoff(db: Db, sessionId: string): R<boolean> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("commands")
        .select("id")
        .where("type", "=", SESSION_HANDOFF)
        // The payload the insert above writes, not its idempotency key: the key's shape is an
        // idempotency detail, and a reader that depended on it would miss a row written any
        // other way.
        .where(payloadField("$.session_id"), "=", sessionId)
        .where(payloadField("$.reason"), "=", PHASE_CHANGE),
    ),
  );
  return found.ok ? ok(found.value !== undefined) : found;
}

/**
 * Inserts the departing holder's `session.handoff` in the transition's own transaction, so the
 * status and the release commit together or not at all. Null: nothing holds the ticket any more
 * (`holdsTicket` — which is why `block`, `park`, `reject`, `split` and `release` never reach here),
 * the holder cannot hand off now, or the move crossed no boundary.
 *
 * `ticket` is the row as the move left it, so its status and version are the landed ones.
 */
export function applyPhaseHandoffIn(
  ix: Internals,
  ticket: TicketRow,
  plan: PlanHandoff,
): Result<PhaseHandoff | null> {
  const holder = holdingSession(ix, ticket);
  if (holder === null) return ok(null);
  const boundary = plan({
    session_id: holder.id,
    run_class: holder.run_class,
  });
  if (boundary === null) return ok(null);
  const inserted = insertCommandIn(ix, {
    type: SESSION_HANDOFF,
    payload: {
      session_id: holder.id,
      reason: PHASE_CHANGE,
      ...(boundary.to === null ? {} : { phase_to: boundary.to }),
    },
    idempotencyKey: phaseHandoffKey(holder.id, ticket.version),
  });
  return inserted.ok
    ? ok({
        session_id: holder.id,
        command_id: inserted.value.id,
        phase_to: boundary.to,
      })
    : inserted;
}

/**
 * The live session holding `ticket` and able to hand off, newest first. §13.1 allows exactly one;
 * ordering makes the choice deterministic if a bug ever left two.
 */
function holdingSession(ix: Internals, ticket: TicketRow): SessionRow | null {
  const live = all(
    ix,
    qb
      .selectFrom("sessions")
      .selectAll()
      .where("ticket_id", "=", ticket.id)
      .where("state", "in", HANDING)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc"),
  );
  return live.find((s) => holdsTicket(s, ticket)) ?? null;
}
