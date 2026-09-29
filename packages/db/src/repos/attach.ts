import { ok, type Result } from "@bayon/core";
import { all, qb, read, write, type Db, type R } from "../connection.js";
import type { SessionRow } from "../schema.js";
import { insertTicketEvent } from "./ticket-common.js";

export interface AttachReleased {
  readonly ticketId: string;
  readonly sessionId: string;
  /** The lease owner token that just released, for the audit trail. */
  readonly actorId: string | null;
  readonly at: number;
}

/** Records a `ticket_events` row for a terminal-takeover release (§12.5): the supervisor's own
 * audit of human intervention, alongside the hand-off it triggers. */
export function recordAttachRelease(db: Db, r: AttachReleased): R<void> {
  return write(db, (ix): Result<void> => {
    insertTicketEvent(ix, {
      ticket_id: r.ticketId,
      ts: r.at,
      actor_kind: "operator",
      actor_id: r.actorId,
      kind: "human_attach",
      from_status: null,
      to_status: null,
      reason: "terminal takeover released",
      payload_json: JSON.stringify({ session_id: r.sessionId }),
    });
    return ok(undefined);
  });
}

/** A "take over after this step" ask (032). */
export interface AttachIntent {
  /** Becomes `attach_lease_owner` when the attach happens. */
  readonly owner: string;
  readonly at: number;
}

/**
 * Records a pending takeover on a `running` session, replacing any earlier one (the latest ask
 * wins). Guarded on the state in the same statement: false when the session is not running any
 * more, so a caller never arms a turn that has already ended. Supervisor-only (§9.5).
 */
export function setAttachIntent(
  db: Db,
  id: string,
  intent: AttachIntent,
): R<boolean> {
  return write(db, (ix) =>
    ok(
      all(
        ix,
        qb
          .updateTable("sessions")
          .set({
            attach_intent_owner: intent.owner,
            attach_intent_at: intent.at,
          })
          .where("id", "=", id)
          .where("state", "=", "running")
          .returning("id"),
      ).length > 0,
    ),
  );
}

/**
 * Clears `id`'s pending takeover, whatever its state: a cancel, a spent or failed attempt, or a
 * stale ask the sweep found. True when there was one to clear.
 */
export function clearAttachIntent(db: Db, id: string): R<boolean> {
  return write(db, (ix) =>
    ok(
      all(
        ix,
        qb
          .updateTable("sessions")
          .set({ attach_intent_owner: null, attach_intent_at: null })
          .where("id", "=", id)
          .where("attach_intent_at", "is not", null)
          .returning("id"),
      ).length > 0,
    ),
  );
}

/** Every session with a pending takeover, oldest ask first: the reconciler's sweep. */
export function listAttachIntents(db: Db): R<SessionRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("sessions")
        .selectAll()
        .where("attach_intent_at", "is not", null)
        .orderBy("attach_intent_at")
        .orderBy("id"),
    ),
  );
}
