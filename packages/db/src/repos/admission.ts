// Admission's reads (§9.1): the facts the supervisor's drain gathers for a
// waiter. Core decides; these only count and list.
import { ok, type SessionState } from "@bayon/core";
import { all, first, qb, read, type Db, type R } from "../connection.js";

/** A session admission let in and has not ended: it holds its agent's concurrency. */
export const ADMITTED_STATES = [
  "preparing",
  "spawning",
  "running",
  "idle",
  "stopping",
  "handoff_writing",
] as const satisfies readonly SessionState[];

/** How many of the agent's sessions are admitted and not ended (the `concurrency` gate). */
export async function countAdmittedSessions(
  db: Db,
  agentId: string,
): R<number> {
  const got = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("sessions")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("agent_id", "=", agentId)
        .where("state", "in", ADMITTED_STATES),
    ),
  );
  return got.ok ? ok(got.value?.n ?? 0) : got;
}

/**
 * How many of this runner's sessions are admitted and not ended (the `runner_concurrency` gate).
 * Scoped to the runner, not to a pair: what one-session-at-a-time protects is the runner's
 * credential, and every session of it shares that whatever executor it runs on.
 */
export async function countLiveSessionsOfRunner(
  db: Db,
  runnerId: string,
): R<number> {
  const got = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("sessions")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("runner_id", "=", runnerId)
        .where("state", "in", ADMITTED_STATES),
    ),
  );
  return got.ok ? ok(got.value?.n ?? 0) : got;
}

/**
 * When this (runner, executor) pair's failed `runner_error` runs ended, since `since`, oldest
 * first (the `retry_storm` gate). Scoped to the pair so one provider's outage never holds another
 * runner. an earlier change adds the runs(ended_at) index this scan wants.
 */
export async function listPairFailuresSince(
  db: Db,
  q: {
    readonly runnerId: string;
    readonly executorId: string;
    readonly since: number;
  },
): R<number[]> {
  const got = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("runs as r")
        .innerJoin("sessions as s", "s.id", "r.session_id")
        .select("r.ended_at")
        .where("s.runner_id", "=", q.runnerId)
        .where("s.executor_id", "=", q.executorId)
        .where("r.state", "=", "failed")
        .where("r.error_class", "=", "runner_error")
        .where("r.ended_at", ">=", q.since)
        .orderBy("r.ended_at"),
    ),
  );
  return got.ok
    ? ok(got.value.flatMap((r) => (r.ended_at === null ? [] : [r.ended_at])))
    : got;
}
