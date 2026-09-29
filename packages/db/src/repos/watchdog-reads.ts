import {
  CIRCUIT_RUN_STATES,
  HANDOFF_RUN_TRIGGER,
  HELD_STATUSES,
  HOLDING_ROLES,
  SPAWN_COMMAND,
  ok,
  type TicketFailure,
} from "@bayon/core";
import { sql } from "kysely";
import {
  all,
  first,
  qb,
  read,
  readSnapshot,
  type Db,
  type R,
} from "../connection.js";
import { attentionAt } from "./attention.js";

// What the watchdog reads. The breaker's predicate is core's
// circuitVerdict: these reads apply only its closed lists (run states, the hand-off trigger,
// holding roles) and leave the class and storm exclusions to it, so the SQL and the verdict cannot
// disagree about what a failure is.

/** Statuses the breaker never considers: closed, or already held by a human. */
const NOT_CIRCUIT: readonly string[] = ["done", "rejected", ...HELD_STATUSES];
/** Statuses a "split?" question skips: a human already holds them (§6). */
const NOT_SPLIT: readonly string[] = ["blocked", "parked"];

/** A (runner, executor) pair with at least `minCount` runner_error failures since `since`. */
export interface StormPair {
  readonly runnerId: string;
  readonly executorId: string;
  readonly failures: number;
}

/** The pairs worth a storm check: grouped, so the watchdog reads each pair's failures once. */
export async function listStormPairs(
  db: Db,
  q: { readonly since: number; readonly minCount: number },
): R<StormPair[]> {
  const rows = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("runs as r")
        .innerJoin("sessions as s", "s.id", "r.session_id")
        .select((eb) => [
          "s.runner_id",
          "s.executor_id",
          eb.fn.countAll<number>().as("n"),
        ])
        .where("r.state", "=", "failed")
        .where("r.error_class", "=", "runner_error")
        .where("r.ended_at", ">=", q.since)
        .groupBy(["s.runner_id", "s.executor_id"])
        .having((eb) => eb.fn.countAll(), ">=", q.minCount)
        .orderBy("s.runner_id")
        .orderBy("s.executor_id"),
    ),
  );
  return rows.ok
    ? ok(
        rows.value.map((r) => ({
          runnerId: r.runner_id,
          executorId: r.executor_id,
          failures: Number(r.n),
        })),
      )
    : rows;
}

/** When the pair's latest ok run ended: the storm notification's recovery point; null if never. */
export async function lastPairOkRunAt(
  db: Db,
  q: { readonly runnerId: string; readonly executorId: string },
): R<number | null> {
  const row = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("runs as r")
        .innerJoin("sessions as s", "s.id", "r.session_id")
        .select((eb) => eb.fn.max("r.ended_at").as("at"))
        .where("s.runner_id", "=", q.runnerId)
        .where("s.executor_id", "=", q.executorId)
        .where("r.state", "=", "ok"),
    ),
  );
  return row.ok ? ok(row.value?.at ?? null) : row;
}

/**
 * Whether an open system request's key starts with `prefix` (one rule and subject). The test is
 * `substr(dedupe_key, 1, length(prefix)) = prefix`, never LIKE: `_` and `%` are LIKE's wildcards,
 * and ids may hold `_`.
 */
export async function hasOpenSystemRequest(db: Db, prefix: string): R<boolean> {
  const row = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("human_requests")
        .select("id")
        .where("status", "=", "open")
        .where(
          sql<boolean>`substr(dedupe_key, 1, length(${prefix})) = ${prefix}`,
        )
        .limit(1),
    ),
  );
  return row.ok ? ok(row.value !== undefined) : row;
}

/** A ticket the breaker considers, with its reset point (§5.2). */
export interface CircuitTicket {
  readonly id: string;
  readonly num: number;
  readonly status: string;
  /** The latest of: its creation, an ok work run of a holding session, an unblock. */
  readonly resetAt: number;
}

export interface TicketFailureRow extends TicketFailure {
  readonly ticketId: string;
}

export interface CircuitFacts {
  readonly tickets: readonly CircuitTicket[];
  /**
   * Every failed run and failed start of the tickets' holding sessions, and every `session.spawn`
   * command that failed before it could write one; core filters them all the same way.
   */
  readonly failures: readonly TicketFailureRow[];
}

const maxOf = (...xs: readonly (number | null | undefined)[]): number =>
  Math.max(0, ...xs.map((x) => x ?? 0));

/**
 * The breaker's facts, in one read snapshot: the open, unheld tickets (or just `ticketId`), each
 * with its reset point, and the raw failures of their holding sessions.
 */
export async function listCircuitFacts(
  db: Db,
  ticketId?: string,
): R<CircuitFacts> {
  return readSnapshot(db, (ix) => {
    const tickets = all(
      ix,
      qb
        .selectFrom("tickets")
        .select(["id", "num", "status", "created_at"])
        .where("status", "not in", NOT_CIRCUIT)
        .$if(ticketId !== undefined, (w) => w.where("id", "=", ticketId ?? ""))
        .orderBy("num"),
    );
    const ids = tickets.map((t) => t.id);
    if (ids.length === 0) return { tickets: [], failures: [] };
    const okRuns = all(
      ix,
      qb
        .selectFrom("runs as r")
        .innerJoin("sessions as s", "s.id", "r.session_id")
        .select((eb) => ["s.ticket_id", eb.fn.max("r.ended_at").as("at")])
        .where("s.ticket_id", "in", ids)
        .where("s.role", "in", HOLDING_ROLES)
        .where("r.state", "=", "ok")
        .where("r.trigger", "<>", HANDOFF_RUN_TRIGGER)
        .groupBy("s.ticket_id"),
    );
    const unblocks = all(
      ix,
      qb
        .selectFrom("ticket_events")
        .select((eb) => ["ticket_id", eb.fn.max("ts").as("at")])
        .where("ticket_id", "in", ids)
        .where("kind", "=", "transition")
        .where("from_status", "=", "blocked")
        .groupBy("ticket_id"),
    );
    const okAt = new Map(okRuns.map((r) => [r.ticket_id, r.at]));
    const unblockAt = new Map(unblocks.map((r) => [r.ticket_id, r.at]));
    const runFailures = all(
      ix,
      qb
        .selectFrom("runs as r")
        .innerJoin("sessions as s", "s.id", "r.session_id")
        .select([
          "s.ticket_id",
          "s.id as session_id",
          "r.id as run_id",
          "s.runner_id",
          "s.executor_id",
          "r.state",
          "r.error_class",
          "r.error_message",
          "r.ended_at",
        ])
        .where("s.ticket_id", "in", ids)
        .where("s.role", "in", HOLDING_ROLES)
        .where("r.state", "in", CIRCUIT_RUN_STATES)
        .where("r.trigger", "<>", HANDOFF_RUN_TRIGGER)
        .where("r.ended_at", "is not", null),
    );
    const startFailures = all(
      ix,
      qb
        .selectFrom("sessions as s")
        .select([
          "s.ticket_id",
          "s.id as session_id",
          "s.runner_id",
          "s.executor_id",
          "s.error_class",
          "s.error_message",
          "s.ended_at",
        ])
        .where("s.ticket_id", "in", ids)
        .where("s.role", "in", HOLDING_ROLES)
        .where("s.state", "=", "exited")
        .where("s.exit_reason", "=", "error")
        .where("s.queued_reason", "is", null)
        .where("s.ended_at", "is not", null)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("runs as r")
                .select("r.id")
                .whereRef("r.session_id", "=", "s.id"),
            ),
          ),
        ),
    );
    // A session.spawn that failed before it ever wrote its session row: the ticket was
    // moved to `staffed` with its command, so without this it sits there with no session to fail,
    // no hand-off and no owner. Only rows with no session: once one exists, the two sources above
    // already see it, and counting both would double every such failure. The command's own error
    // class rides along, so core's exclusions decide — an `interrupted` attempt cap is a fleet
    // condition and stays excluded exactly as a restart-interrupted session does.
    const spawnFailures = all(
      ix,
      qb
        .selectFrom("commands as c")
        .select([
          sql<string>`json_extract(c.payload_json, '$.ticket_id')`.as(
            "ticket_id",
          ),
          sql<string>`json_extract(c.payload_json, '$.session_id')`.as(
            "session_id",
          ),
          sql<string | null>`json_extract(c.error, '$.class')`.as(
            "error_class",
          ),
          sql<string | null>`json_extract(c.error, '$.message')`.as(
            "error_message",
          ),
          "c.ts",
        ])
        .where("c.type", "=", SPAWN_COMMAND)
        .where("c.state", "=", "failed")
        .where(
          sql<string>`json_extract(c.payload_json, '$.ticket_id')`,
          "in",
          ids,
        )
        .where(
          sql<string>`json_extract(c.payload_json, '$.role')`,
          "in",
          HOLDING_ROLES,
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("sessions as s2")
                .select("s2.id")
                .whereRef(
                  "s2.id",
                  "=",
                  sql<string>`json_extract(c.payload_json, '$.session_id')`,
                ),
            ),
          ),
        ),
    );
    const failures: TicketFailureRow[] = [
      ...runFailures.map((r) => ({
        ticketId: r.ticket_id ?? "",
        kind: "run" as const,
        sessionId: r.session_id,
        runId: r.run_id,
        runnerId: r.runner_id,
        executorId: r.executor_id,
        state: r.state,
        errorClass: r.error_class,
        errorMessage: r.error_message,
        at: r.ended_at ?? 0,
      })),
      ...startFailures.map((s) => ({
        ticketId: s.ticket_id ?? "",
        kind: "start" as const,
        sessionId: s.session_id,
        runId: null,
        runnerId: s.runner_id,
        executorId: s.executor_id,
        state: "exited",
        errorClass: s.error_class,
        errorMessage: s.error_message,
        at: s.ended_at ?? 0,
      })),
      ...spawnFailures.map((c) => ({
        ticketId: c.ticket_id,
        kind: "spawn_command" as const,
        sessionId: c.session_id,
        runId: null,
        // The command never resolved far enough to name either: it failed before or inside resolve.
        runnerId: "",
        executorId: "",
        state: "failed",
        errorClass: c.error_class,
        errorMessage: c.error_message,
        at: c.ts,
      })),
    ];
    return {
      tickets: tickets.map((t) => ({
        id: t.id,
        num: t.num,
        status: t.status,
        resetAt: maxOf(t.created_at, okAt.get(t.id), unblockAt.get(t.id)),
      })),
      failures,
    };
  });
}

/** A ticket on the split_candidate arm that a human does not already hold (§6). */
export interface SplitAsk {
  readonly ticketId: string;
  readonly num: number;
  readonly status: string;
  readonly handoffs: number;
  readonly degraded: number;
}

/** The split_candidate arm (autosplit.handoff_threshold), with each chain's size and degraded count. */
export async function listSplitAsks(db: Db): R<SplitAsk[]> {
  return readSnapshot(db, (ix) => {
    const tickets = all(
      ix,
      qb
        .selectFrom(attentionAt(ix.clock.now()).as("v"))
        .innerJoin("tickets as t", "t.id", "v.ref")
        .select(["t.id", "t.num", "t.status"])
        .where("v.why", "=", "split_candidate")
        .where("t.status", "not in", NOT_SPLIT)
        .orderBy("t.num"),
    );
    const ids = tickets.map((t) => t.id);
    if (ids.length === 0) return [];
    const counts = all(
      ix,
      qb
        .selectFrom("handoffs")
        .select((eb) => [
          "ticket_id",
          eb.fn.countAll<number>().as("n"),
          sql<number>`sum(CASE WHEN quality = 'degraded' THEN 1 ELSE 0 END)`.as(
            "degraded",
          ),
        ])
        .where("ticket_id", "in", ids)
        .groupBy("ticket_id"),
    );
    const byTicket = new Map(counts.map((c) => [c.ticket_id, c]));
    return tickets.map((t) => ({
      ticketId: t.id,
      num: t.num,
      status: t.status,
      handoffs: Number(byTicket.get(t.id)?.n ?? 0),
      degraded: Number(byTicket.get(t.id)?.degraded ?? 0),
    }));
  });
}
