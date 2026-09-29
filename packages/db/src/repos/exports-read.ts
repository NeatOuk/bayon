// Read-only mission listing for the markdown exporter (spec §10.5), ordered in SQL so
// two runs over the same data produce the same file order. Tickets themselves reuse the existing
// `listTickets` (repos/tickets.ts) rather than duplicating it here; gates, findings, hand-offs and
// the transition log are read per ticket via `listTicketGates`/`listTicketFindings`/
// `listTicketHandoffs`/`listTicketEvents` (work-views.ts, ticket-events.ts).
import type { Db, R } from "../connection.js";
import { all, qb, read } from "../connection.js";
import type { MissionRow } from "../schema.js";

/** Every mission version ever created (immutable once inserted), per agent, oldest first. */
export function listMissionsForExport(db: Db): R<MissionRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("missions")
        .selectAll()
        .orderBy("agent_name")
        .orderBy("version"),
    ),
  );
}
