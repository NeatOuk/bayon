import { err, ok, type JsonValue } from "@bayon/core";
import { all, qb, read, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";
import { attentionAt } from "./attention.js";
import { getBudgetCap } from "./budget.js";
import { dayStart } from "./spend-math.js";
import { getSpendSummary } from "./spend-rollups.js";

// The named queries `sql` probes run (§10.2; Invariant 6). A probe row names one by id in
// spec_json.query, and the id is only ever a key into QUERIES: no SQL ever comes from a row.
// The attention queries read their arm of v_needs_attention, so a migration that redefines an arm
// (005 excludes hand-off packets still being written) changes the probe with it.

/** Findings per query at most: a probe reports anomalies, the context pack is no table dump. */
export const PROBE_QUERY_ROWS = 50;

export interface ProbeFinding {
  /** Stable across pulses for one anomaly: the dedupe fingerprint is taken over it (§10.2). */
  readonly subject: string;
  readonly facts: { readonly [key: string]: JsonValue };
}

type ProbeQuery = (db: Db) => R<ProbeFinding[]>;

/** Sessions idle past the view's stale threshold (30 min). */
const staleSessions: ProbeQuery = (db) =>
  read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom(attentionAt(ix.clock.now()).as("v"))
        .innerJoin("sessions as s", "s.id", "v.ref")
        .select([
          "s.id",
          "s.agent_id",
          "s.ticket_id",
          "s.role",
          "s.state",
          "s.last_event_at",
        ])
        .where("v.why", "=", "stale_session")
        .orderBy("s.last_event_at")
        .orderBy("s.id")
        .limit(PROBE_QUERY_ROWS),
    ).map((s) => ({
      subject: s.id,
      facts: {
        session_id: s.id,
        agent_id: s.agent_id,
        ticket_id: s.ticket_id,
        role: s.role,
        state: s.state,
        last_event_at: s.last_event_at,
      },
    })),
  );

/** Hand-offs nobody has accepted yet: the view's handoff_pending arm (amendment c). */
const handoffPending: ProbeQuery = (db) =>
  read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom(attentionAt(ix.clock.now()).as("v"))
        .innerJoin("handoffs as h", "h.id", "v.ref")
        .select([
          "h.id",
          "h.ticket_id",
          "h.from_session_id",
          "h.reason",
          "h.goal_line",
          "h.created_at",
        ])
        .where("v.why", "=", "handoff_pending")
        .orderBy("h.created_at")
        .orderBy("h.id")
        .limit(PROBE_QUERY_ROWS),
    ).map((h) => ({
      subject: h.id,
      facts: {
        handoff_id: h.id,
        ticket_id: h.ticket_id,
        from_session_id: h.from_session_id,
        reason: h.reason,
        goal_line: h.goal_line,
        created_at: h.created_at,
      },
    })),
  );

/** Failed gates and gates running past the gate wall clock: the view's gate_stuck arm. Empty until
 * M3 writes gates. */
const gateHealth: ProbeQuery = (db) =>
  read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom(attentionAt(ix.clock.now()).as("v"))
        .innerJoin("gates as g", "g.id", "v.ref")
        .select([
          "g.id",
          "g.ticket_id",
          "g.kind",
          "g.state",
          "g.attempt",
          "g.started_at",
        ])
        .where("v.why", "=", "gate_stuck")
        .orderBy("g.started_at")
        .orderBy("g.id")
        .limit(PROBE_QUERY_ROWS),
    ).map((g) => ({
      subject: g.id,
      facts: {
        gate_id: g.id,
        ticket_id: g.ticket_id,
        kind: g.kind,
        state: g.state,
        attempt: g.attempt,
        started_at: g.started_at,
      },
    })),
  );

/**
 * Today's spend against `budget.daily_cap_usd`, and the burn alarm (§8.9), from the existing
 * reads. One finding per anomaly and UTC day, so the same overrun files one ticket a day at most.
 */
const budget: ProbeQuery = async (db) => {
  const cap = await getBudgetCap(db);
  if (!cap.ok) return cap;
  const spend = await getSpendSummary(db);
  if (!spend.ok) return spend;
  const { burn, alarm, window } = spend.value;
  const day = new Date(dayStart(window.to)).toISOString().slice(0, 10);
  const facts = {
    today_usd: burn.today_usd,
    daily_cap_usd: cap.value,
    projected_month_usd: burn.projected_month_usd,
  };
  const overCap =
    cap.value !== null && burn.today_usd > 0 && burn.today_usd >= cap.value;
  return ok([
    ...(overCap ? [{ subject: `over_cap:${day}`, facts }] : []),
    ...(alarm.active
      ? [
          {
            subject: `burn_alarm:${day}`,
            facts: {
              ...facts,
              threshold_pct: alarm.threshold_pct,
              last_day_pct: alarm.last_day.change_pct,
              last_7d_pct: alarm.last_7d.change_pct,
            },
          },
        ]
      : []),
  ]);
};

const QUERIES: ReadonlyMap<string, ProbeQuery> = new Map([
  ["stale_sessions", staleSessions],
  ["handoff_pending", handoffPending],
  ["gate_health", gateHealth],
  ["budget", budget],
]);

/** The query ids a `sql` probe may name. */
export const PROBE_QUERY_IDS: readonly string[] = [...QUERIES.keys()];

/** Runs the query named `id`. Any other id, SQL text included, is refused (`validation`). */
export function runProbeQuery(db: Db, id: string): R<ProbeFinding[]> {
  const query = QUERIES.get(id);
  return query === undefined
    ? Promise.resolve(
        err(
          failure(
            "validation",
            `no probe query is named ${JSON.stringify(id.slice(0, 64))}; the ids are ${PROBE_QUERY_IDS.join(", ")}`,
          ),
        ),
      )
    : query(db);
}
