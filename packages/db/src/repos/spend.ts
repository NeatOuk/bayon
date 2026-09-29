import { err, newId, ok } from "@bayon/core";
import { sql, type Insertable } from "kysely";
import {
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
import type { SpendRow, SpendTable } from "../schema.js";

/** §8.9: an abandoned session's spend bought nothing, so every one of its rows is wasted. */
export const WASTES_SESSION_SPEND = "abandoned";

/** Flags every spend row of the session wasted, inside the caller's transaction. */
export function wasteSessionSpend(ix: Internals, sessionId: string): void {
  execute(
    ix,
    qb
      .updateTable("spend")
      .set({ wasted: 1 })
      .where("session_id", "=", sessionId)
      .where("wasted", "=", 0),
  );
}

/** A run's spend row (§8.9: at most one), or null if it has none yet. */
export async function getRunSpend(db: Db, runId: string): R<SpendRow | null> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("spend").selectAll().where("run_id", "=", runId)),
  );
  return found.ok ? ok(found.value ?? null) : found;
}

export type NewSpend = Omit<Insertable<SpendTable>, "id" | "ts"> & {
  readonly id?: string;
  readonly ts?: number;
};

type TokenColumn =
  | "tokens_in"
  | "tokens_out"
  | "tokens_cache_read"
  | "tokens_cache_write"
  | "tokens_saved";
const add = (column: TokenColumn, delta: number | undefined) =>
  sql<number>`coalesce(${sql.ref(column)}, 0) + ${delta ?? 0}`;

/**
 * Writes a run's spend row (§8.9: one per run) and adds its tokens to the session, whose cost
 * becomes its spend rows' sum: that replaces the run's in-flight estimate (setSessionInFlight). A
 * repeat for the same run returns the first row's id with `created: false` and adds nothing. A
 * row for a session that already ended abandoned is wasted, whatever `s.wasted` says. A run's
 * estimated saving from context compression (049) is added to the session's only when the run has
 * one: a session never proxied keeps NULL, never "saved 0".
 */
export function insertSpend(
  db: Db,
  s: NewSpend,
): R<{ id: string; created: boolean }> {
  return write<{ id: string; created: boolean }>(db, (ix) => {
    const existing = first(
      ix,
      qb.selectFrom("spend").select("id").where("run_id", "=", s.run_id),
    );
    if (existing !== undefined) return ok({ id: existing.id, created: false });
    const owner = first(
      ix,
      qb
        .selectFrom("runs")
        .innerJoin("sessions", "sessions.id", "runs.session_id")
        .select(["runs.session_id", "sessions.exit_reason"])
        .where("runs.id", "=", s.run_id),
    );
    if (owner === undefined)
      return err(failure("validation", `run ${s.run_id} does not exist`));
    if (owner.session_id !== s.session_id) {
      return err(
        failure(
          "validation",
          `run ${s.run_id} belongs to session ${owner.session_id}, not ${s.session_id}`,
        ),
      );
    }
    const now = ix.clock.now();
    const id = s.id ?? newId(now);
    const wasted =
      owner.exit_reason === WASTES_SESSION_SPEND ? 1 : (s.wasted ?? 0);
    execute(
      ix,
      qb.insertInto("spend").values({ ...s, id, ts: s.ts ?? now, wasted }),
    );
    execute(
      ix,
      qb
        .updateTable("sessions")
        .set({
          cost_usd: sql<number>`(SELECT total(cost_usd) FROM spend WHERE session_id = ${s.session_id})`,
          tokens_in: add("tokens_in", s.tokens_in),
          tokens_out: add("tokens_out", s.tokens_out),
          tokens_cache_read: add("tokens_cache_read", s.tokens_cache_read),
          tokens_cache_write: add("tokens_cache_write", s.tokens_cache_write),
          ...(s.tokens_saved === undefined || s.tokens_saved === null
            ? {}
            : { tokens_saved: add("tokens_saved", s.tokens_saved) }),
        })
        .where("id", "=", s.session_id),
    );
    return ok({ id, created: true });
  });
}
