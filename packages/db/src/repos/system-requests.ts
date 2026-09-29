import {
  SYSTEM_REQUEST_KIND,
  SystemHumanRequest,
  dedupeKey,
  err,
  newId,
  ok,
  type Result,
} from "@bayon/core";
import { z } from "zod";
import {
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { HumanRequestRow } from "../schema-work.js";
import { insertAudit } from "./audit.js";
import { insertTicketEvent } from "./ticket-common.js";

// insertSystemHumanRequest: the supervisor's one
// human_requests writer. Its key `<rule>:<subject>:<window>` sits under a plain unique index (014),
// so a second request for the same condition and window is refused by the database: the insert is
// ON CONFLICT DO NOTHING, and the existing row comes back with created=false. A created row is
// audited in the same transaction with actor 'supervisor' (audit_log, and ticket_events when it
// names a ticket). The supervisor never answers, expires or closes a request: those are the API's.

/** Who a system request's audit rows name. */
export const SUPERVISOR_ACTOR = "supervisor";
/** Which of the supervisor's parts acts: its ticket_events rows carry it as actor_id. */
export const WATCHDOG_ACTOR_ID = "watchdog";

export interface SystemRequestWritten {
  readonly created: boolean;
  readonly row: HumanRequestRow;
}

/** The request inside the caller's write transaction (blockTicket files one with its block). */
export function insertSystemHumanRequestIn(
  ix: Internals,
  r: SystemHumanRequest,
): Result<SystemRequestWritten> {
  const parsed = SystemHumanRequest.safeParse(r);
  if (!parsed.success) {
    return err(
      failure("validation", `system request: ${z.prettifyError(parsed.error)}`),
    );
  }
  const p = parsed.data;
  const key = dedupeKey(p);
  const now = ix.clock.now();
  const inserted = first(
    ix,
    qb
      .insertInto("human_requests")
      .values({
        id: newId(now),
        session_id: p.session_id ?? null,
        ticket_id: p.ticket_id ?? null,
        kind: SYSTEM_REQUEST_KIND[p.rule],
        question: p.question,
        context_md: p.context_md,
        options_json: JSON.stringify(p.options),
        batch_id: null,
        status: "open",
        asked_at: now,
        expires_at: p.expires_at ?? null,
        dedupe_key: key,
      })
      .onConflict((oc) => oc.column("dedupe_key").doNothing())
      .returningAll(),
  );
  if (inserted === undefined) {
    const existing = first(
      ix,
      qb.selectFrom("human_requests").selectAll().where("dedupe_key", "=", key),
    );
    return existing === undefined
      ? err(
          failure("internal", `system request ${key}: no row after a conflict`),
        )
      : ok({ created: false, row: existing });
  }
  const audit = insertAudit(ix, {
    actor: SUPERVISOR_ACTOR,
    action: "supervisor.human_request",
    target_kind: "human_request",
    target_id: inserted.id,
    payload: { rule: p.rule, key },
  });
  if (!audit.ok) return audit;
  if (inserted.ticket_id !== null) {
    insertTicketEvent(ix, {
      ticket_id: inserted.ticket_id,
      ts: now,
      actor_kind: SUPERVISOR_ACTOR,
      actor_id: WATCHDOG_ACTOR_ID,
      kind: "human_request",
      from_status: null,
      to_status: null,
      reason: p.rule,
      payload_json: JSON.stringify({ human_request_id: inserted.id, key }),
    });
  }
  return ok({ created: true, row: inserted });
}

/** Files one system request, or returns the one its key already names. */
export function insertSystemHumanRequest(
  db: Db,
  r: SystemHumanRequest,
): R<SystemRequestWritten> {
  return write(db, (ix) => insertSystemHumanRequestIn(ix, r));
}
