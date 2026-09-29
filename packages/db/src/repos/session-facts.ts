import { sql } from "kysely";
import { all, first, qb, read, type Db, type R } from "../connection.js";
import type { EventRow } from "../schema.js";

// Reads for a hand-off's generated facts and its run caps: events and
// counters only, never model output.

/** The session's canonical `command` events, newest first, at most `limit`. */
export function listSessionCommands(
  db: Db,
  sessionId: string,
  limit: number,
): R<EventRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("events")
        .selectAll()
        .where("session_id", "=", sessionId)
        .where("kind", "=", "command")
        .orderBy("id", "desc")
        .limit(limit),
    ),
  );
}

/** A run's top-level `turn_start` events (a subagent's carry `parent_call_id`). */
export async function countRunTurnStarts(
  db: Db,
  sessionId: string,
  runId: string,
): R<number> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("events")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("session_id", "=", sessionId)
        .where("run_id", "=", runId)
        .where("kind", "=", "turn_start")
        .where(
          sql<boolean>`json_extract(payload_json, '$.parent_call_id') IS NULL`,
        ),
    ),
  );
  return found.ok ? { ok: true, value: found.value?.count ?? 0 } : found;
}

export interface EventRange {
  readonly first: number | null;
  readonly last: number | null;
}

/** The session's first and last event ids: a packet's logs pointer. */
export async function getSessionEventRange(
  db: Db,
  sessionId: string,
): R<EventRange> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("events")
        .select((eb) => [
          eb.fn.min<number | null>("id").as("first"),
          eb.fn.max<number | null>("id").as("last"),
        ])
        .where("session_id", "=", sessionId),
    ),
  );
  return found.ok
    ? {
        ok: true,
        value: {
          first: found.value?.first ?? null,
          last: found.value?.last ?? null,
        },
      }
    : found;
}
