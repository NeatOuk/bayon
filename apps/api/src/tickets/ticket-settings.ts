import {
  TICKET_SETTINGS_KEYS,
  parseTicketSettings,
  type Result,
  type TicketSettings,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";

/**
 * The tickets module's settings, read per write so an operator's change applies at once: rows
 * over core's defaults, an invalid row a validation error (never a silent default).
 */
export async function loadTicketSettings(
  db: Db,
): Promise<Result<TicketSettings>> {
  const rows = await getSettings(db, TICKET_SETTINGS_KEYS);
  return rows.ok ? parseTicketSettings(rows.value) : rows;
}
