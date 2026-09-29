import {
  EventKind,
  err,
  ok,
  parseCanonical,
  type CanonicalEvent,
} from "@bayon/core";
import { sql, type Insertable, type SqlBool } from "kysely";
import { z } from "zod";
import {
  all,
  execute,
  first,
  qb,
  read,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { EventRow, EventsTable } from "../schema.js";

/** The runner_type of events the supervisor writes itself. Their raw_offset is -runs.seq. */
export const SUPERVISOR_RUNNER_TYPE = "frm.supervisor";

/**
 * An event to insert. raw_offset is required: with session_id and runner_type it is the replay
 * key. It is the byte offset in the raw log (plus the mapper's ordinal), so it is >= 0, except
 * for supervisor events, which use -runs.seq.
 */
export type EventInsert = Omit<Insertable<EventsTable>, "id" | "raw_offset"> & {
  readonly raw_offset: number;
};

export interface EventsQuery {
  readonly sessionId: string;
  /** An events.id; exclusive. */
  readonly since: number;
  readonly kinds?: readonly EventKind[];
  /** 1 to 1000. */
  readonly limit: number;
}

const EventsQuery = z.object({
  sessionId: z.string().min(1),
  since: z.int().nonnegative(),
  kinds: z.array(EventKind).min(1).optional(),
  limit: z.int().min(1).max(1000),
});

// Each tool invocation counts once, whatever a runner emits for it: tool_call and
// mcp_call always; a `command` only when its session holds no tool_call with the same call id. So a
// runner that reports one call as tool_call + command counts it once, and a bare command counts.
const INVOCATION_KINDS: ReadonlySet<EventKind> = new Set([
  "tool_call",
  "mcp_call",
]);

const CallId = z.object({ call_id: z.string().min(1) });

/** Whether a newly stored row is a tool invocation. Runs in the batch's transaction, after its inserts. */
function isInvocation(ix: Internals, e: EventInsert): boolean {
  if (INVOCATION_KINDS.has(e.kind)) return true;
  if (e.kind !== "command") return false;
  const named = CallId.safeParse(parsePayload(e.payload_json ?? null));
  if (!named.success) return true;
  const paired = first(
    ix,
    qb
      .selectFrom("events")
      .select("id")
      .where("session_id", "=", e.session_id)
      // The literal kind and this exact expression are what events_tool_call_idx (006) indexes;
      // the CASE never raises on a malformed payload, which a bare json_extract would.
      .where(
        sql<SqlBool>`kind = 'tool_call' AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.call_id') END) = ${named.data.call_id}`,
      )
      .limit(1),
  );
  return paired === undefined;
}

const validOffset = (e: EventInsert) =>
  Number.isSafeInteger(e.raw_offset) &&
  (e.raw_offset >= 0 || e.runner_type === SUPERVISOR_RUNNER_TYPE);

// Every column, absent ones as NULL, so each insert compiles to the same cached statement.
const columns = (e: EventInsert): Insertable<EventsTable> => ({
  session_id: e.session_id,
  run_id: e.run_id ?? null,
  ts: e.ts,
  kind: e.kind,
  runner_type: e.runner_type,
  tool_name: e.tool_name ?? null,
  status: e.status ?? null,
  exit_code: e.exit_code ?? null,
  text: e.text ?? null,
  payload_json: e.payload_json ?? null,
  payload_path: e.payload_path ?? null,
  bytes_original: e.bytes_original ?? null,
  truncated: e.truncated ?? 0,
  raw_offset: e.raw_offset,
});

/** Adds only the newly stored events to the session and run counters, in the same transaction. */
function bumpCounters(ix: Internals, stored: readonly EventInsert[]): void {
  const invocations = new Set(stored.filter((e) => isInvocation(ix, e)));
  for (const [sessionId, rows] of Map.groupBy(stored, (e) => e.session_id)) {
    const lastTs = Math.max(...rows.map((e) => e.ts));
    execute(
      ix,
      qb
        .updateTable("sessions")
        .set((eb) => ({
          turns: eb(
            "turns",
            "+",
            rows.filter((e) => e.kind === "turn_end").length,
          ),
          tool_calls: eb(
            "tool_calls",
            "+",
            rows.filter((e) => invocations.has(e)).length,
          ),
          last_event_at: sql<number>`max(coalesce(last_event_at, 0), ${lastTs})`,
        }))
        .where("id", "=", sessionId),
    );
  }
  for (const [runId, rows] of Map.groupBy(
    invocations,
    (e) => e.run_id ?? null,
  )) {
    if (runId === null) continue;
    execute(
      ix,
      qb
        .updateTable("runs")
        .set({
          tool_calls: sql<number>`coalesce(tool_calls, 0) + ${rows.length}`,
        })
        .where("id", "=", runId),
    );
  }
}

/**
 * Inserts a batch in one transaction. A row whose (session_id, runner_type, raw_offset) is stored
 * already is skipped, so a replay after a crash inserts nothing twice; `inserted` counts the new
 * rows and `lastId` is their highest id. Session turns (turn_end), tool calls (each invocation
 * once, see isInvocation) and last_event_at, and run tool calls, move for new rows only.
 */
export async function insertEventsBatch(
  db: Db,
  rows: readonly EventInsert[],
): R<{ inserted: number; lastId: number | null }> {
  const bad = rows.findIndex((row) => !validOffset(row));
  if (bad >= 0) {
    return err(
      failure(
        "validation",
        `row ${bad}: raw_offset must be an integer, and >= 0 unless runner_type is ${SUPERVISOR_RUNNER_TYPE}`,
      ),
    );
  }
  if (rows.length === 0) return ok({ inserted: 0, lastId: null });
  return write(db, (ix) => {
    const stored = rows.flatMap((row) => {
      const hit = first(
        ix,
        qb
          .insertInto("events")
          .values(columns(row))
          .onConflict((oc) =>
            oc.columns(["session_id", "runner_type", "raw_offset"]).doNothing(),
          )
          .returning("id"),
      );
      return hit === undefined ? [] : [{ row, id: hit.id }];
    });
    bumpCounters(
      ix,
      stored.map((s) => s.row),
    );
    return ok({
      inserted: stored.length,
      lastId: stored.length === 0 ? null : Math.max(...stored.map((s) => s.id)),
    });
  });
}

/** A run's first `terminal` row by id (the one that won, §5.2), or null if it has none. */
export async function getFirstTerminal(
  db: Db,
  runId: string,
): R<EventRow | null> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("events")
        .selectAll()
        .where("run_id", "=", runId)
        .where("kind", "=", "terminal")
        .orderBy("id")
        .limit(1),
    ),
  );
  return found.ok ? ok(found.value ?? null) : found;
}

/**
 * The highest raw-log offset a session has stored, supervisor rows (negative offsets) left out,
 * or null if none. Batches commit in raw-log order, so replay skips everything at or below it.
 */
export async function getMaxRawOffset(
  db: Db,
  sessionId: string,
): R<number | null> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("events")
        .select((eb) => eb.fn.max<number | null>("raw_offset").as("max"))
        .where("session_id", "=", sessionId)
        .where("raw_offset", ">=", 0),
    ),
  );
  return found.ok ? ok(found.value?.max ?? null) : found;
}

/** A page of a session's events after the exclusive cursor `since`, in id order. */
export async function getEventsSince(
  db: Db,
  q: EventsQuery,
): R<{ rows: EventRow[]; nextCursor: number; hasMore: boolean }> {
  const parsed = EventsQuery.safeParse(q);
  if (!parsed.success)
    return err(failure("validation", z.prettifyError(parsed.error)));
  const { sessionId, since, kinds, limit } = parsed.data;
  return read(db, (ix) => {
    const base = qb
      .selectFrom("events")
      .selectAll()
      .where("session_id", "=", sessionId)
      .where("id", ">", since);
    const filtered =
      kinds === undefined ? base : base.where("kind", "in", kinds);
    const rows = all(ix, filtered.orderBy("id").limit(limit + 1));
    const page = rows.slice(0, limit);
    return {
      rows: page,
      nextCursor: page.at(-1)?.id ?? since,
      hasMore: rows.length > limit,
    };
  });
}

function parsePayload(json: string | null): unknown {
  if (json === null) return {};
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}

/**
 * The canonical event a row holds. NULL columns are left out: a CanonicalEvent's optional fields
 * are absent, never null. A row that no longer parses comes back as runner_native, never dropped.
 */
export function toCanonical(row: EventRow): CanonicalEvent & { id: number } {
  const optional = Object.entries({
    run_id: row.run_id,
    tool_name: row.tool_name,
    status: row.status,
    exit_code: row.exit_code,
    text: row.text,
  }).filter(([, value]) => value !== null);
  const input = {
    kind: row.kind,
    ts: row.ts,
    runner_type: row.runner_type,
    ...Object.fromEntries(optional),
    payload: parsePayload(row.payload_json),
  };
  return { ...parseCanonical(input, { now: () => row.ts }), id: row.id };
}
