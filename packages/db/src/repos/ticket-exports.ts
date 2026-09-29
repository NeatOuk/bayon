import type { Insertable } from "kysely";
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
import type {
  TicketExportRow,
  TicketExportState,
  TicketExportsTable,
} from "../schema-work.js";

// ticket_exports (§10.5) is the supervisor's (M1 amendment 5): the exporter's script runner
// reports each file it wrote, and the supervisor records it here.

const STATES: readonly TicketExportState[] = ["pending", "synced", "failed"];

/** A whole ticket_exports row, as the exporter's manifest reports it. */
export type TicketExportUpsert = Omit<
  Insertable<TicketExportsTable>,
  "state"
> & { readonly state: TicketExportState };

/**
 * Records a ticket's export to `target`: inserts the row, or replaces every column of the one
 * there (a column left out goes back to its default), so the row is always the latest report
 * and a sync clears an old error.
 */
export async function upsertTicketExport(
  db: Db,
  e: TicketExportUpsert,
): R<TicketExportRow> {
  const checked = allOk(
    requireText({ ticket_id: e.ticket_id, target: e.target }),
    check(STATES.includes(e.state), `unknown export state ${e.state}`),
  );
  if (!checked.ok) return checked;
  const columns = {
    external_key: e.external_key ?? null,
    url: e.url ?? null,
    path: e.path ?? null,
    direction: e.direction ?? "push",
    content_hash: e.content_hash ?? null,
    state: e.state,
    last_synced_at: e.last_synced_at ?? null,
    error: e.error ?? null,
  };
  return write(db, (ix) =>
    returningOne(
      ix,
      qb
        .insertInto("ticket_exports")
        .values({ ticket_id: e.ticket_id, target: e.target, ...columns })
        .onConflict((oc) =>
          oc.columns(["ticket_id", "target"]).doUpdateSet(columns),
        )
        .returningAll(),
    ),
  );
}

/** A ticket's exports, by target. */
export function listTicketExports(
  db: Db,
  ticketId: string,
): R<TicketExportRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("ticket_exports")
        .selectAll()
        .where("ticket_id", "=", ticketId)
        .orderBy("target"),
    ),
  );
}
