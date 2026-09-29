import { err, newId, ok, type RunOutcome } from "@bayon/core";
import type { Insertable, Updateable } from "kysely";
import {
  all,
  first,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type R,
} from "../connection.js";
import { casMiss, failure, orNotFound } from "../errors.js";
import type { RunRow, RunsTable } from "../schema.js";

/** A run by id: ingest reads its seq (the supervisor terminal's raw_offset) and state. */
export async function getRun(db: Db, id: string): R<RunRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("runs").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `run ${id}`);
}

/** A new run. `id` defaults to a new ULID, for a supervisor that mints it before `send`. */
export type NewRun = Omit<
  Insertable<RunsTable>,
  "id" | "seq" | "state" | "started_at"
> & {
  readonly id?: string;
};

export type RunFinish = { readonly state: RunOutcome } & Pick<
  Updateable<RunsTable>,
  "error_class" | "error_message" | "wasted" | "prompt_tokens_actual"
>;

/**
 * Starts a run: state `running`, seq = the session's highest + 1. A repeated idempotency_key
 * returns the run it created; the same key on another session is a conflict.
 */
export function appendRun(db: Db, r: NewRun): R<RunRow> {
  return write(db, (ix) => {
    const key = r.idempotency_key;
    if (key !== undefined && key !== null) {
      const existing = first(
        ix,
        qb.selectFrom("runs").selectAll().where("idempotency_key", "=", key),
      );
      if (existing !== undefined) {
        return existing.session_id === r.session_id
          ? ok(existing)
          : err(
              failure(
                "conflict",
                `idempotency key ${key} belongs to a run of session ${existing.session_id}`,
              ),
            );
      }
    }
    const last = first(
      ix,
      qb
        .selectFrom("runs")
        .select((eb) => eb.fn.max<number | null>("seq").as("seq"))
        .where("session_id", "=", r.session_id),
    );
    const now = ix.clock.now();
    return returningOne(
      ix,
      qb
        .insertInto("runs")
        .values({
          ...r,
          id: r.id ?? newId(now),
          seq: (last?.seq ?? 0) + 1,
          state: "running",
          started_at: now,
        })
        .returningAll(),
    );
  });
}

/**
 * The session's open run: its latest run with no `terminal` event, whatever runs.state says, so a
 * run whose state a timer already set still gets its terminal (Invariant 3). Null when none.
 */
export async function getOpenRun(db: Db, sessionId: string): R<RunRow | null> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("runs")
        .selectAll()
        .where("session_id", "=", sessionId)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("events")
                .select("events.id")
                .whereRef("events.run_id", "=", "runs.id")
                .where("events.kind", "=", "terminal"),
            ),
          ),
        )
        .orderBy("seq", "desc")
        .limit(1),
    ),
  );
  return found.ok ? ok(found.value ?? null) : found;
}

/** A session's runs, by seq. */
export function listRuns(db: Db, sessionId: string): R<RunRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("runs")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("seq"),
    ),
  );
}

/** Ends a run: a compare-and-set from `running`, stamping ended_at. */
export function finishRun(db: Db, id: string, f: RunFinish): R<RunRow> {
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("runs")
        .set({ ...f, ended_at: ix.clock.now() })
        .where("id", "=", id)
        .where("state", "=", "running")
        .returningAll(),
    );
    if (row !== undefined) return ok(row);
    const current = first(
      ix,
      qb.selectFrom("runs").select("state").where("id", "=", id),
    );
    return casMiss(`run ${id}`, current, ["running"]);
  });
}
