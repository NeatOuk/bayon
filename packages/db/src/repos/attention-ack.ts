// Dismissing a finished session's error from the Fleet attention strip. API-owned
// (§9.5): the operator acts through REST, so this never runs on the supervisor's side.
//
// Only an error exit is acknowledgeable. A stale session is a live condition — it clears itself on
// its next event, or when the operator stops it — so hiding one "for good" would bury something
// still true and still actionable. The refusal below keeps that honest at the door, and the
// single-column key keeps it honest in the schema.
import { err, ok, type Result } from "@bayon/core";
import { check } from "../checks.js";
import { execute, first, qb, write, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";
import type { AttentionAckRow } from "../schema-fleet.js";
import { insertAudit } from "./audit.js";

/**
 * Records that `by` dismissed `sessionId`'s error exit, audited as `attention.ack` in the same
 * transaction. Acknowledging one already dismissed is not an error: the strip reads the same
 * either way, and a retried click should not fail. Refuses a session that is not an error exit —
 * there is nothing terminal to dismiss — and one that does not exist.
 */
export async function ackAttention(
  db: Db,
  sessionId: string,
  by: string,
): R<AttentionAckRow> {
  const checked = check(
    by.trim().length > 0,
    "an acknowledgement needs an actor",
  );
  if (!checked.ok) return checked;
  return write(db, (ix): Result<AttentionAckRow> => {
    const session = first(
      ix,
      qb
        .selectFrom("sessions")
        .select(["id", "state", "exit_reason"])
        .where("id", "=", sessionId),
    );
    if (session === undefined) {
      return err(failure("not_found", `session ${sessionId} does not exist`));
    }
    if (session.state !== "exited" || session.exit_reason !== "error") {
      // Named plainly, so a stale entry's remedy stays the real one: stop it, or let it run on.
      return err(
        failure(
          "conflict",
          `session ${sessionId} is ${session.state}, not an error exit: only a finished session's error can be dismissed`,
        ),
      );
    }
    execute(
      ix,
      qb
        .insertInto("attention_acks")
        .values({
          session_id: sessionId,
          acked_at: ix.clock.now(),
          acked_by: by,
        })
        // Already dismissed: keep the first acknowledgement, which is the one that happened.
        .onConflict((oc) => oc.column("session_id").doNothing()),
    );
    const row = first(
      ix,
      qb
        .selectFrom("attention_acks")
        .selectAll()
        .where("session_id", "=", sessionId),
    );
    if (row === undefined) {
      return err(
        failure("internal", `session ${sessionId} was not acknowledged`),
      );
    }
    const audit = insertAudit(ix, {
      actor: by,
      action: "attention.ack",
      target_kind: "session",
      target_id: sessionId,
      payload: { acked_at: row.acked_at },
    });
    return audit.ok ? ok(row) : audit;
  });
}
