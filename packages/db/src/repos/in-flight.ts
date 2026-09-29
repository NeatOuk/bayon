import { err, ok } from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import {
  first,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { ModelRow, SessionRow } from "../schema.js";

// The in-flight ceilings' reads and writer (§7.1, §13.2): a session's model (its window
// and prices) and its mid-run cost and context peak, which the supervisor writes (§9.5).

/** The runner's row for `model`, active first: the context window and prices. Null if none. */
export async function getRunnerModel(
  db: Db,
  runnerId: string,
  model: string,
): R<ModelRow | null> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("models")
        .selectAll()
        .where("runner_id", "=", runnerId)
        .where("model", "=", model)
        .orderBy("active", "desc")
        .orderBy("id")
        .limit(1),
    ),
  );
  return found.ok ? ok(found.value ?? null) : found;
}

const InFlight = z.object({
  session_id: z.string().min(1),
  /** The latest run whose steps were priced, or null if none reported usage. */
  run_id: z.string().min(1).nullable(),
  /** That run's cost so far; it counts only until the run's spend row settles it. */
  run_cost_usd: z.number().nonnegative(),
  /** The largest context a step reported, or null if none did (never guessed). */
  context_peak_tokens: z.int().nonnegative().nullable(),
});
export type InFlight = z.infer<typeof InFlight>;

/**
 * Sets the session's mid-run cost and context peak in one statement. cost_usd = its spend rows'
 * sum (settled runs, reported cost where the runner reported one) + the open run's estimate while
 * that run has no spend row, so a terminal that settles it meanwhile is never counted twice.
 * context_peak_tokens only ever grows.
 */
export function setSessionInFlight(db: Db, f: InFlight): R<SessionRow> {
  const parsed = InFlight.safeParse(f);
  if (!parsed.success) {
    return Promise.resolve(
      err(failure("validation", z.prettifyError(parsed.error))),
    );
  }
  const v = parsed.data;
  const settled = sql<number>`(SELECT total(cost_usd) FROM spend WHERE session_id = ${v.session_id})`;
  const open =
    v.run_id === null
      ? sql<number>`0`
      : sql<number>`CASE WHEN EXISTS (SELECT 1 FROM spend WHERE run_id = ${v.run_id}) THEN 0 ELSE ${v.run_cost_usd} END`;
  return write(db, (ix) =>
    returningOne(
      ix,
      qb
        .updateTable("sessions")
        .set({
          cost_usd: sql<number>`${settled} + ${open}`,
          ...(v.context_peak_tokens === null
            ? {}
            : {
                context_peak_tokens: sql<number>`max(coalesce(${sql.ref("context_peak_tokens")}, 0), ${v.context_peak_tokens})`,
              }),
        })
        .where("id", "=", v.session_id)
        .returningAll(),
    ),
  );
}
