import {
  CI_SUBJECT,
  FAILURE_CLASS,
  GATE_SETTING_KEYS,
  MERGE_STATUSES,
  NO_CI_WAIT,
  QA_GATE_MODES,
  REVIEW_GATE_KINDS,
  ROUND_KINDS,
  STAFF_APPROVAL_KIND,
  SessionState,
  TicketStatus,
  err,
  ok,
  type CiWait,
  type NextStepHolder,
  type NextStepStarting,
  type Result,
  type WaitFacts,
} from "@bayon/core";
import { sql, type RawBuilder } from "kysely";
import { z } from "zod";
import {
  all,
  first,
  qb,
  readSnapshot,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { pausedIn } from "./fleet-control.js";
import { openQuestionOn } from "./open-questions.js";
import { ENDED_STATES } from "./sessions.js";
import { couldStaff } from "./staff-pool.js";

// Why a ticket waits: the facts core's nextStep and waitingOnYou read that are not the
// laws' own. `listWaitFacts` is the board's one set-based pass — a row per ticket of the page, each
// fact a correlated subquery on an indexed ticket_id, the gate ones only for a status a gate decides
// (SQLite's CASE evaluates lazily) — so a page of 100 cards costs one statement, never one per card.
// `getNextStepFacts` reads the same columns for one ticket, and its holder, reviewers and park note.

const LIVE_STATES = SessionState.options.filter(
  (s) => !(ENDED_STATES as readonly string[]).includes(s),
);
const INFRA_REASONS = Object.entries(FAILURE_CLASS).flatMap(([reason, cls]) =>
  cls === "infra" ? [reason] : [],
);
const list = (values: readonly string[]) =>
  sql.join(values.map((v) => sql.lit(v)));

/**
 * A `session.spawn` for ticket `t` the supervisor has not made a session of yet: the
 * predicate staffing's `queuedSpawns` holds a slot by, alias `c`.
 */
const QUEUED_SPAWN = sql`SELECT 1 FROM commands c WHERE c.state IN ('pending','claimed')
    AND c.type = 'session.spawn' AND json_extract(c.payload_json, '$.ticket_id') = t.id
    AND NOT EXISTS (SELECT 1 FROM sessions qs WHERE qs.id = json_extract(c.payload_json, '$.session_id'))`;

/** The current round of ticket `t` (023): the highest any of its gates carries. */
const ROUND = sql`(SELECT max(m.round) FROM gates m WHERE m.ticket_id = t.id)`;

/** Gate alias `g` is of a kind ticket `t`'s status is decided by (plan_review, the round, QA). */
const statusKinds = (g: string) =>
  sql`(${sql.ref(`${g}.kind`)} = t.status OR (t.status = 'code_review' AND ${sql.ref(`${g}.kind`)} IN (${list(ROUND_KINDS)})))`;

/** Gate alias `g` is the latest attempt of its (ticket, kind, repo) and in `t`'s current round. */
const latestInRound = (g: string) =>
  sql`${sql.ref(`${g}.round`)} = ${ROUND} AND NOT EXISTS (
    SELECT 1 FROM gates n WHERE n.ticket_id = ${sql.ref(`${g}.ticket_id`)} AND n.kind = ${sql.ref(`${g}.kind`)}
      AND n.repo_id IS ${sql.ref(`${g}.repo_id`)} AND n.attempt > ${sql.ref(`${g}.attempt`)})`;

/** The reason gate alias `g`'s evidence records, or NULL (none, or not JSON). */
const reasonOf = (g: string) =>
  sql`CASE WHEN json_valid(${sql.ref(`${g}.evidence_json`)}) THEN json_extract(${sql.ref(`${g}.evidence_json`)}, '$.reason') END`;

/** Only for a ticket in a status a gate decides: every other status reads 0 without a lookup. */
const whenGated = (expr: RawBuilder<unknown>) =>
  sql<number>`CASE WHEN t.status IN ('plan_review','code_review','qa_harness') THEN ${expr} ELSE 0 END`;

/**
 * Core's `driftStreak` over ticket `t`: its current round less the latest round in which no
 * review-round gate failed because the base moved.
 */
const DRIFT_STREAK = sql`(${ROUND} - coalesce((SELECT max(x.round) FROM gates x WHERE x.ticket_id = t.id
    AND NOT EXISTS (SELECT 1 FROM gates d WHERE d.ticket_id = t.id AND d.round = x.round
      AND d.kind IN (${list(ROUND_KINDS)}) AND d.state = 'failed' AND ${reasonOf("d")} = 'base_drift')), 0))`;

/** Below core's `driftCapped`; an unreadable `gates.drift_rounds_max` caps nothing here. */
const underDriftCap = (max: number | null) =>
  max === null ? sql`1` : sql`${DRIFT_STREAK} < ${max}`;

/** The columns both reads share, over ticket alias `t`. */
function sharedColumns(blocking: readonly string[], driftMax: number | null) {
  const reviewRunning = sql`SELECT 1 FROM gates g WHERE g.ticket_id = t.id AND g.state = 'running'
    AND ${statusKinds("g")} AND g.kind IN (${list(REVIEW_GATE_KINDS)})`;
  return [
    sql<number>`(SELECT count(*) FROM ${openQuestionOn("t.id")})`.as(
      "open_questions",
    ),
    sql<number>`EXISTS (SELECT 1 FROM human_requests hr WHERE hr.ticket_id = t.id
      AND hr.status = 'open' AND hr.kind = ${STAFF_APPROVAL_KIND})`.as(
      "proposal_open",
    ),
    sql<number>`EXISTS (SELECT 1 FROM handoffs h WHERE h.ticket_id = t.id
      AND h.accepted_at IS NULL AND h.quality <> 'writing')`.as(
      "handoff_pending",
    ),
    // Its project's orchestrator, or one of the fleet's (no project): an orchestrator reads its scope.
    sql<number>`EXISTS (SELECT 1 FROM agents a WHERE a.kind = 'orchestrator' AND a.enabled = 1
      AND (a.workspace_id = t.workspace_id OR a.workspace_id IS NULL))`.as(
      "has_orchestrator",
    ),
    sql<number>`coalesce((SELECT w.paused FROM workspaces w WHERE w.id = t.workspace_id), 0)`.as(
      "project_paused",
    ),
    // The laws' own `qa_configured`: the project runs a command harness or
    // waits on its CI. Hard-coded false here until, so the board and the next step said
    // "pass it with a note" for a ticket whose harness was running.
    sql<number>`coalesce((SELECT w.qa_mode IN (${list(QA_GATE_MODES)}) FROM workspaces w
      WHERE w.id = t.workspace_id), 0)`.as("qa_configured"),
    sql<
      string | null
    >`(SELECT s.state FROM sessions s WHERE s.ticket_id = t.id AND s.gate_id IS NULL
      AND s.state IN (${list(LIVE_STATES)}) ORDER BY s.created_at DESC, s.id DESC LIMIT 1)`.as(
      "holder_state",
    ),
    sql<number>`EXISTS (${QUEUED_SPAWN})`.as("spawn_queued"),
    sql<number>`EXISTS (SELECT 1 FROM sessions rv WHERE rv.ticket_id = t.id AND rv.gate_id IS NOT NULL
      AND rv.state IN (${list(LIVE_STATES)}))`.as("reviewer_live"),
    sql<number>`CASE WHEN t.status = 'split' THEN
      NOT EXISTS (SELECT 1 FROM tickets c WHERE c.parent_ticket_id = t.id
                    AND c.status NOT IN ('done','rejected','parked'))
      AND NOT EXISTS (SELECT 1 FROM worktrees wt WHERE wt.ticket_id = t.id AND wt.state = 'active')
      ELSE 0 END`.as("split_closable"),
    whenGated(sql`EXISTS (SELECT 1 FROM gates g WHERE g.ticket_id = t.id AND g.state = 'running'
      AND ${statusKinds("g")})`).as("running"),
    whenGated(sql`EXISTS (${reviewRunning}) AND NOT EXISTS (${reviewRunning} AND EXISTS (
      SELECT 1 FROM sessions rs WHERE rs.gate_id = g.id AND rs.state IN (${list(LIVE_STATES)})))`).as(
      "reviewer_awaited",
    ),
    whenGated(sql`EXISTS (SELECT 1 FROM gates g WHERE g.ticket_id = t.id AND g.kind = t.status
      AND g.round = ${ROUND})`).as("anchored"),
    // What pass_review owes (core's table): a trivial ticket no ce_review, a non-trivial one one.
    whenGated(sql`NOT (t.status = 'code_review' AND t.non_trivial = 1 AND NOT EXISTS (
        SELECT 1 FROM gates c WHERE c.ticket_id = t.id AND c.kind = 'ce_review' AND c.round = ${ROUND}))
      AND NOT EXISTS (SELECT 1 FROM gates g WHERE g.ticket_id = t.id AND ${statusKinds("g")}
        AND (g.kind <> 'ce_review' OR t.non_trivial = 1) AND ${latestInRound("g")}
        AND g.state NOT IN ('passed','waived'))`).as("settled"),
    // Core's `sentBackToFix`: failed on the code with a blocker open, or a round kind still owed
    // whose base moved, which a fix round answers whatever findings it carries.
    // Past gates.drift_rounds_max no fix round is sent: the operator decides (core's reviewStep).
    whenGated(sql`${underDriftCap(driftMax)} AND EXISTS (SELECT 1 FROM gates g WHERE g.ticket_id = t.id AND ${statusKinds("g")}
      AND ${latestInRound("g")} AND g.state = 'failed' AND (
        (${reasonOf("g")} = 'base_drift' AND g.kind IN (${list(ROUND_KINDS)})
          AND (g.kind <> 'ce_review' OR t.non_trivial = 1))
        OR (${reasonOf("g")} = 'blocking_findings'
          AND EXISTS (SELECT 1 FROM findings f WHERE f.gate_id = g.id AND f.status = 'open'
                    AND f.severity IN (${blocking.length === 0 ? sql`NULL` : list(blocking)})))))`).as(
      "code_failed",
    ),
    // The most urgent latest failure, as nextStep answers them: infra, the base, the work, the rest.
    sql<
      string | null
    >`CASE WHEN t.status IN ('plan_review','code_review','qa_harness') THEN (
      SELECT ${reasonOf("g")} FROM gates g WHERE g.ticket_id = t.id AND ${statusKinds("g")}
        AND ${latestInRound("g")} AND g.state = 'failed'
      ORDER BY CASE WHEN ${reasonOf("g")} IN (${list(INFRA_REASONS)}) THEN 0
                    WHEN ${reasonOf("g")} = 'base_drift' THEN 1
                    WHEN ${reasonOf("g")} IN ('blocking_findings','source_changes') THEN 2
                    ELSE 3 END, g.kind, g.repo_id
      LIMIT 1) END`.as("failure"),
    // What its pull requests say, core's `unmergedReason`/`awaitingMerge` over the
    // ticket's deliveries, only in a status a merge closes and a project that closes on merge.
    sql<string>`CASE WHEN t.status IN (${list(MERGE_STATUSES)}) AND coalesce((SELECT w.close_on_merge
        FROM workspaces w WHERE w.id = t.workspace_id), 0) = 1
      AND EXISTS (SELECT 1 FROM deliveries d WHERE d.ticket_id = t.id AND d.pr_url IS NOT NULL) THEN
      CASE WHEN NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ticket_id = t.id
               AND (d.state IN ('pr_open','failed') OR (d.pr_url IS NOT NULL AND d.state <> 'merged')))
             THEN 'merged'
           WHEN NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ticket_id = t.id
               AND d.pr_url IS NOT NULL AND d.state <> 'pr_open')
             THEN 'awaiting'
           ELSE 'none' END
      ELSE 'none' END`.as("merge"),
  ] as const;
}

const BlockingSeverities = z.array(z.string());
const DriftRoundsMax = z.int().positive();

/** `gates.drift_rounds_max` as the laws read it; null when missing or unreadable. */
function driftRoundsMax(ix: Internals): number | null {
  const row = first(
    ix,
    qb
      .selectFrom("settings")
      .select("value_json")
      .where("key", "=", GATE_SETTING_KEYS.drift_rounds_max),
  );
  if (row === undefined) return null;
  try {
    const parsed = DriftRoundsMax.safeParse(JSON.parse(row.value_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // the ticket page says the gate settings are unreadable
  }
}

/** `gates.blocking_severities` as the laws read it; none when it does not parse (nothing blocks). */
function blockingSeverities(ix: Internals): readonly string[] {
  const row = first(
    ix,
    qb
      .selectFrom("settings")
      .select("value_json")
      .where("key", "=", GATE_SETTING_KEYS.blocking_severities),
  );
  if (row === undefined) return [];
  try {
    const parsed = BlockingSeverities.safeParse(JSON.parse(row.value_json));
    return parsed.success ? parsed.data : [];
  } catch {
    return []; // an unreadable setting blocks nothing here; the ticket page says it is unreadable
  }
}

interface SharedRow {
  readonly open_questions: number;
  readonly proposal_open: number;
  readonly handoff_pending: number;
  readonly has_orchestrator: number;
  readonly project_paused: number;
  readonly holder_state: string | null;
  readonly spawn_queued: number;
  readonly reviewer_live: number;
  readonly split_closable: number;
  readonly running: number;
  readonly reviewer_awaited: number;
  readonly anchored: number;
  readonly settled: number;
  readonly code_failed: number;
  readonly failure: string | null;
  readonly merge: string;
  readonly qa_configured: number;
}

const MergeWaitOf = z.enum(["none", "awaiting", "merged"]).catch("none");

function waitFactsOf(
  row: SharedRow & {
    readonly status: string;
    readonly needs_human: number;
    readonly blocked_reason: string | null;
  },
  fleetPaused: boolean,
): Result<WaitFacts> {
  const status = TicketStatus.safeParse(row.status);
  if (!status.success) {
    return err(
      failure("internal", `a ticket has an unknown status: ${row.status}`),
    );
  }
  return ok({
    status: status.data,
    needs_human: row.needs_human === 1,
    blocked_reason: row.blocked_reason,
    open_questions: row.open_questions,
    proposal_open: row.proposal_open === 1,
    holder_state: row.holder_state,
    spawn_queued: row.spawn_queued === 1,
    reviewer_live: row.reviewer_live === 1,
    handoff_pending: row.handoff_pending === 1,
    has_orchestrator: row.has_orchestrator === 1,
    fleet_paused: fleetPaused,
    project_paused: row.project_paused === 1,
    split_closable: row.split_closable === 1,
    review: {
      running: row.running === 1,
      reviewerAwaited: row.reviewer_awaited === 1,
      anchored: row.anchored === 1,
      settled: row.settled === 1,
      codeFailed: row.code_failed === 1,
      failure: row.failure,
    },
    qa_configured: row.qa_configured === 1,
    merge: MergeWaitOf.parse(row.merge),
  });
}

function gatherWaits(
  ix: Internals,
  ticketIds: readonly string[],
): Result<ReadonlyMap<string, WaitFacts>> {
  const paused = pausedIn(ix);
  if (!paused.ok) return paused;
  const rows = all(
    ix,
    qb
      .selectFrom("tickets as t")
      .select(["t.id", "t.status", "t.needs_human", "t.blocked_reason"])
      .select(sharedColumns(blockingSeverities(ix), driftRoundsMax(ix)))
      .where("t.id", "in", [...ticketIds]),
  );
  const out = new Map<string, WaitFacts>();
  for (const row of rows) {
    const facts = waitFactsOf(row, paused.value);
    if (!facts.ok) return facts;
    out.set(row.id, facts.value);
  }
  return ok(out);
}

/** Each of `ticketIds`' wait facts, in one read: what the board's cards say they wait on. */
export async function listWaitFacts(
  db: Db,
  ticketIds: readonly string[],
): R<ReadonlyMap<string, WaitFacts>> {
  if (ticketIds.length === 0) return ok(new Map());
  const found = await readSnapshot(db, (ix) => gatherWaits(ix, ticketIds));
  return found.ok ? found.value : found;
}

/** The ticket's holder, with its session: what the ticket page links to. */
export interface TicketHolderFact extends NextStepHolder {
  readonly session_id: string;
}

/** A live gate reviewer on the ticket: never its holder, but staffing counts it. */
export interface TicketReviewingFact {
  readonly agent: string;
  readonly session_id: string;
}

/** What nextStep reads beside the laws' facts (which getTicketFacts reads). */
export interface NextStepDbFacts {
  readonly openQuestions: number;
  readonly proposalOpen: boolean;
  readonly holder: TicketHolderFact | null;
  /** The spawn staffing queued, before its session row exists. */
  readonly starting: NextStepStarting | null;
  /** A live reviewer session on it: staffing refuses while one is. */
  readonly reviewing: TicketReviewingFact | null;
  /** A builder staffing could pick for it (staff-pool.ts couldStaff). */
  readonly hasBuilder: boolean;
  /** The ticket's running gates whose reviewer session is live. */
  readonly liveGateIds: readonly string[];
  readonly handoffPending: boolean;
  readonly parkNote: string | null;
  readonly pause: { readonly fleet: boolean; readonly project: boolean };
  readonly hasOrchestrator: boolean;
  readonly qaConfigured: boolean;
  /** A running CI gate's last recorded read of the ticket's pull requests. */
  readonly ci: CiWait;
}

/**
 * What the CI sweep recorded for the ticket's running CI gate: the pull requests it
 * read **for that gate at their current head**, and their checks settled of required. A read by an
 * earlier gate, or of a head since replaced by a push, counts for nothing — so a new round never
 * shows the last round's "3 of 3".
 */
function ciWaitOf(ix: Internals, ticketId: string): CiWait {
  const row = first(
    ix,
    qb
      .selectFrom("deliveries as d")
      .innerJoin("gates as g", "g.id", "d.ci_gate_id")
      .select([
        sql<number>`count(*)`.as("pulls"),
        sql<number>`coalesce(sum(d.ci_done), 0)`.as("done"),
        sql<number>`coalesce(sum(d.ci_total), 0)`.as("total"),
      ])
      .where("d.ticket_id", "=", ticketId)
      .where("g.state", "=", "running")
      .where("g.subject_kind", "=", CI_SUBJECT)
      .whereRef("d.ci_sha", "=", "d.head_sha"),
  );
  return row === undefined
    ? NO_CI_WAIT
    : { pulls: row.pulls, done: row.done, total: row.total };
}

const LiveState = SessionState.exclude([...ENDED_STATES]);

function holderOf(
  ix: Internals,
  ticketId: string,
): Result<TicketHolderFact | null> {
  const row = first(
    ix,
    qb
      .selectFrom("sessions as s")
      .innerJoin("agents as a", "a.id", "s.agent_id")
      .leftJoin("runners as r", "r.id", "s.runner_id")
      .select(["s.id", "a.name as agent", "s.state", "s.turns", "r.kind"])
      .where("s.ticket_id", "=", ticketId)
      .where("s.gate_id", "is", null)
      .where("s.state", "in", LIVE_STATES)
      .orderBy("s.created_at", "desc")
      .orderBy("s.id", "desc")
      .limit(1),
  );
  if (row === undefined) return ok(null);
  const state = LiveState.safeParse(row.state);
  return state.success
    ? ok({
        session_id: row.id,
        agent: row.agent,
        state: state.data,
        turns: row.turns,
        scripted: row.kind === "script",
      })
    : err(failure("internal", `session state ${row.state} is not a live one`));
}

/** The agent of the ticket's newest queued spawn with no session row yet, or null. */
function startingOf(ix: Internals, ticketId: string): NextStepStarting | null {
  const row = first(
    ix,
    qb
      .selectFrom("commands as c")
      .innerJoin("agents as a", (join) =>
        join.on(
          sql<boolean>`a.id = json_extract(c.payload_json, '$.agent_id')`,
        ),
      )
      .select("a.name as agent")
      .where("c.type", "=", "session.spawn")
      .where("c.state", "in", ["pending", "claimed"])
      .where(
        sql<boolean>`json_extract(c.payload_json, '$.ticket_id') = ${ticketId}`,
      )
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM sessions qs WHERE qs.id = json_extract(c.payload_json, '$.session_id'))`,
      )
      .orderBy("c.ts", "desc")
      .limit(1),
  );
  return row === undefined ? null : { agent: row.agent };
}

/** A live reviewer session on the ticket, newest first: it holds staffing off. */
function reviewingOf(
  ix: Internals,
  ticketId: string,
): TicketReviewingFact | null {
  const row = first(
    ix,
    qb
      .selectFrom("sessions as s")
      .innerJoin("agents as a", "a.id", "s.agent_id")
      .select(["s.id", "a.name as agent"])
      .where("s.ticket_id", "=", ticketId)
      .where("s.gate_id", "is not", null)
      .where("s.state", "in", LIVE_STATES)
      .orderBy("s.created_at", "desc")
      .orderBy("s.id", "desc")
      .limit(1),
  );
  return row === undefined ? null : { agent: row.agent, session_id: row.id };
}

function gatherNext(
  ix: Internals,
  ticketId: string,
): Result<NextStepDbFacts> | undefined {
  const row = first(
    ix,
    qb
      .selectFrom("tickets as t")
      .select(["t.id", "t.workspace_id"])
      .select(sharedColumns(blockingSeverities(ix), driftRoundsMax(ix)))
      .where("t.id", "=", ticketId),
  );
  if (row === undefined) return undefined;
  const paused = pausedIn(ix);
  if (!paused.ok) return paused;
  const holder = holderOf(ix, ticketId);
  if (!holder.ok) return holder;
  const liveGateIds = all(
    ix,
    qb
      .selectFrom("gates as g")
      .innerJoin("sessions as s", "s.gate_id", "g.id")
      .select("g.id")
      .distinct()
      .where("g.ticket_id", "=", ticketId)
      .where("g.state", "=", "running")
      .where("s.state", "in", LIVE_STATES)
      .orderBy("g.id"),
  ).map((g) => g.id);
  const parked = first(
    ix,
    qb
      .selectFrom("ticket_events")
      .select("reason")
      .where("ticket_id", "=", ticketId)
      .where("kind", "=", "transition")
      .where("to_status", "=", "parked")
      .orderBy("id", "desc")
      .limit(1),
  );
  return ok({
    openQuestions: row.open_questions,
    proposalOpen: row.proposal_open === 1,
    holder: holder.value,
    starting: startingOf(ix, ticketId),
    reviewing: reviewingOf(ix, ticketId),
    hasBuilder: couldStaff(ix, "builder", row.workspace_id),
    liveGateIds,
    handoffPending: row.handoff_pending === 1,
    parkNote: parked?.reason ?? null,
    pause: { fleet: paused.value, project: row.project_paused === 1 },
    hasOrchestrator: row.has_orchestrator === 1,
    qaConfigured: row.qa_configured === 1,
    ci: ciWaitOf(ix, ticketId),
  });
}

/** One ticket's next-step facts in one snapshot; an unknown ticket is `not_found`. */
export async function getNextStepFacts(
  db: Db,
  ticketId: string,
): R<NextStepDbFacts> {
  const found = await readSnapshot(db, (ix) => gatherNext(ix, ticketId));
  if (!found.ok) return found;
  return (
    found.value ??
    err(failure("not_found", `ticket ${ticketId} does not exist`))
  );
}
