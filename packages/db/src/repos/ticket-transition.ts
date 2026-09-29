import { ok, type Result } from "@bayon/core";
import { allOk, check } from "../checks.js";
import {
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { optionalJson } from "../json.js";
import type { TicketRow } from "../schema.js";
import {
  actorColumns,
  checkActor,
  checkColumns,
  checkVersion,
  insertTicketEvent,
  versionMiss,
  type TicketActor,
} from "./ticket-common.js";
import { audited, type AuditEntry } from "./audit.js";
import { applyGateEffectsIn, type PlanGates } from "./gate-writes.js";
import { applyPhaseHandoffIn, type PlanHandoff } from "./phase-handoff.js";
import { factsOf, type TransitionFacts } from "./ticket-facts.js";
import { recordTicketReposIn } from "./ticket-repos.js";
import type { TicketPatch } from "./ticket-writes.js";

// The API's status writer (§3.2, contract 2). The laws are the caller's `decide`; this runs it
// inside the write transaction and writes the status and its ticket_event together.

export type { TransitionFacts } from "./ticket-facts.js";

export interface TransitionRequest {
  readonly id: string;
  /** The version the caller read (If-Match). */
  readonly version: number;
  readonly to: string;
  /**
   * The status actually written, when the edge carries the ticket past `to` because the review
   * that status waits on is not required (core's `advanceStatus`). `to` stays the edge
   * the laws judge — `decide` never sees this — so the move remains the one the table allows.
   */
  readonly advanceTo?: string;
  readonly by: TicketActor;
  /** Columns that move with the status, e.g. blocked_reason or closed_at. */
  readonly patch?: TicketPatch;
  /** Evidence refs, stored as the transition event's payload (§3.2). */
  readonly payload?: unknown;
  /**
   * The repos this move found the ticket touching (§3.1), recorded in `ticket_repos`
   * before the edge's round is planned, so the round opens a gate for each. The caller establishes
   * them outside the transaction (the API, from the worktrees' git); an empty or absent list writes
   * nothing, which is the documented "one repo-less gate" shape of a single-repo ticket.
   */
  readonly touchedRepos?: readonly string[];
}

/**
 * The law check, pure over the facts. An error result refuses the transition: the transaction
 * rolls back and the error comes back to the caller unchanged, rule and reason intact.
 */
export type Decide = (
  facts: TransitionFacts,
  req: TransitionRequest,
) => Result<void>;

/**
 * Moves a ticket to `to` in one BEGIN IMMEDIATE transaction: read it, check the version, run
 * `decide` over the facts, then write the status (a version compare-and-set, applying `patch`)
 * and its `transition` ticket_event. A version miss is `not_found`, or a `conflict` carrying
 * `current_version`, and `decide` does not run.
 */
export async function transitionTicket(
  db: Db,
  req: TransitionRequest,
  decide: Decide,
  /** An MCP write's audit entry, committed in the same transaction. */
  audit?: AuditEntry,
  /**
   * The edge's gate effects (M3 amendment h), planned over the facts read after the move: running
   * gates it supersedes, then the rounds it opens with their gate.run commands, all in this
   * transaction.
   */
  gates?: PlanGates,
  /**
   * The edge's phase-boundary effect (§7.1): the `session.handoff` that releases a
   * holder whose phase this move ended, inserted last so the plan stays pure and the widest write
   * in the API gains only one more insert.
   */
  handoff?: PlanHandoff,
): R<TicketRow> {
  const payload = checkTransition(req);
  if (!payload.ok) return payload;
  return write(db, (ix) => {
    const ticket = first(
      ix,
      qb.selectFrom("tickets").selectAll().where("id", "=", req.id),
    );
    if (ticket === undefined || ticket.version !== req.version) {
      return versionMiss(ix, req.id, req.version);
    }
    const moved = moveTicket(ix, ticket, req, payload.value, decide);
    if (!moved.ok) return audited(ix, moved, audit);
    // Before the gates: the round this edge opens reads `ticket_repos` in this same transaction,
    // so a repo recorded here gets its gate in the round this move opens.
    const recorded = recordTicketReposIn(
      ix,
      moved.value.id,
      req.touchedRepos ?? [],
    );
    if (!recorded.ok) return recorded;
    if (gates !== undefined) {
      const effects = applyGateEffectsIn(ix, moved.value, gates, req.by);
      if (!effects.ok) return effects;
    }
    if (handoff !== undefined) {
      const released = applyPhaseHandoffIn(ix, moved.value, handoff);
      if (!released.ok) return released;
    }
    return audited(ix, moved, audit);
  });
}

/** A transition request's checks; its payload as JSON text. */
export function checkTransition(req: TransitionRequest): Result<string | null> {
  const checked = allOk(
    check(req.to.trim().length > 0, "to is empty"),
    check(
      req.advanceTo === undefined || req.advanceTo.trim().length > 0,
      "advanceTo is empty",
    ),
    checkVersion(req.version),
    checkActor(req.by),
    checkColumns(req.patch ?? {}, "a transition patch", ["status"]),
  );
  if (!checked.ok) return checked;
  return optionalJson(req.payload, "payload");
}

/**
 * transitionTicket's move inside the caller's transaction (staffTicket's staff edge commits with
 * its spawn): `decide` over the facts, then the status compare-and-set and its ticket_event.
 * `ticket` is the row the caller read in this transaction.
 */
export function moveTicket(
  ix: Internals,
  ticket: TicketRow,
  req: TransitionRequest,
  payloadJson: string | null,
  decide: Decide,
): Result<TicketRow> {
  const decided = decide(factsOf(ix, ticket), req);
  if (!decided.ok) return decided;
  const now = ix.clock.now();
  // The laws judged req.to; the ticket lands on advanceTo when that status waits on a review this
  // move does not open, and the event records where it actually went.
  const landed = req.advanceTo ?? req.to;
  const row = first(
    ix,
    qb
      .updateTable("tickets")
      .set({
        ...req.patch,
        status: landed,
        version: req.version + 1,
        updated_at: now,
      })
      .where("id", "=", req.id)
      .where("version", "=", req.version)
      .returningAll(),
  );
  if (row === undefined) return versionMiss(ix, req.id, req.version);
  insertTicketEvent(ix, {
    ticket_id: req.id,
    ts: now,
    kind: "transition",
    from_status: ticket.status,
    to_status: landed,
    ...actorColumns(req.by),
    payload_json: payloadJson,
  });
  return ok(row);
}
