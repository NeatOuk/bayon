// Who did what, as the M1 smoke checks it: an actor's audit_log rows and a session's
// human requests. Reads only: both tables are the API's to write (§9.5).
import type { Selectable } from "kysely";
import { all, qb, read, type Db, type R } from "../connection.js";
import type { AuditLogTable } from "../schema.js";
import type { HumanRequestRow } from "../schema-work.js";

export type AuditRow = Selectable<AuditLogTable>;

/** Every audit row `actor` (e.g. `session:<id>`) left, in append order. */
export function listAuditByActor(db: Db, actor: string): R<AuditRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("audit_log")
        .selectAll()
        .where("actor", "=", actor)
        .orderBy("id"),
    ),
  );
}

/** The human requests `sessionId` opened, in the order asked. */
export function listSessionHumanRequests(
  db: Db,
  sessionId: string,
): R<HumanRequestRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("human_requests")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("asked_at")
        .orderBy("id"),
    ),
  );
}
