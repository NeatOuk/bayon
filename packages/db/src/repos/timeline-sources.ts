// The sources of a project's timeline: each is one SELECT over the table that already
// holds its rows, scoped to the project and normalized to the same eleven columns, in the same
// order (a UNION matches columns by position). timeline.ts filters, pages and unions them.
//
// A summary is built here, in SQL, so `q` can filter it inside each source; it is one line, capped
// at TIMELINE_SUMMARY_MAX characters. Raw `events` rows are not a source: they are the per-session
// replay's.
import {
  TIMELINE_PAYLOAD_MAX_BYTES,
  TIMELINE_SUMMARY_MAX,
  type TimelineSource,
} from "@bayon/core";
import { sql, type RawBuilder } from "kysely";
import { qb } from "../connection.js";

/** One timeline row as every source selects it. */
export interface TimelineRaw {
  source: string;
  key: string;
  ts: number;
  kind: string;
  actor: string;
  agent_id: string | null;
  ticket_id: string | null;
  ticket_num: number | null;
  session_id: string | null;
  summary: string;
  payload_json: string | null;
}

/** What every source is built for: the project, and the prefix its summaries print keys with. */
export interface SourceScope {
  readonly workspaceId: string;
  readonly keyPrefix: string;
}

type Sql<T> = RawBuilder<T>;
const ref = <T>(column: string): Sql<T> => sql.ref<T>(column);

interface Columns {
  readonly source: TimelineSource;
  readonly key: Sql<string>;
  readonly ts: Sql<number>;
  readonly kind: Sql<string>;
  readonly actor: Sql<string>;
  readonly agent_id: Sql<string | null>;
  readonly ticket_id: Sql<string | null>;
  readonly ticket_num: Sql<number | null>;
  readonly session_id: Sql<string | null>;
  readonly summary: Sql<string>;
  readonly payload_json?: Sql<string | null>;
}

/** One line: CR and LF flattened to spaces, cut at TIMELINE_SUMMARY_MAX characters. */
const line = (text: Sql<string>): Sql<string> =>
  sql<string>`substr(replace(replace(${text}, char(13), ' '), char(10), ' '), 1, ${TIMELINE_SUMMARY_MAX})`;

/**
 * A stored payload when it is JSON and fits TIMELINE_PAYLOAD_MAX_BYTES; NULL (left out) otherwise, so
 * one malformed row never fails a whole page.
 */
const small = (payload: Sql<string | null>): Sql<string | null> =>
  sql<
    string | null
  >`CASE WHEN length(CAST(${payload} AS BLOB)) <= ${TIMELINE_PAYLOAD_MAX_BYTES} AND json_valid(${payload}) THEN ${payload} END`;

/** An integer id as a key whose text order is its numeric order. */
const padded = (id: Sql<number>): Sql<string> =>
  sql<string>`printf('%020d', ${id})`;

/** `session:<id>` for a session column, else `supervisor` (the writer of every lifecycle row). */
const sessionActor = (session: Sql<string | null>): Sql<string> =>
  sql<string>`coalesce('session:' || ${session}, 'supervisor')`;

/** The normalized row, in the one column order every source uses. */
const row = (c: Columns) =>
  [
    sql<string>`${c.source}`.as("source"),
    c.key.as("key"),
    c.ts.as("ts"),
    c.kind.as("kind"),
    c.actor.as("actor"),
    c.agent_id.as("agent_id"),
    c.ticket_id.as("ticket_id"),
    c.ticket_num.as("ticket_num"),
    c.session_id.as("session_id"),
    line(c.summary).as("summary"),
    (c.payload_json ?? sql<string | null>`NULL`).as("payload_json"),
  ] as const;

/** `<prefix><num>` for a ticket-number column; NULL when the row has no ticket. */
const keyOf = (s: SourceScope, num: string): Sql<string | null> =>
  sql<string | null>`${s.keyPrefix} || ${ref<number | null>(num)}`;

/** audit_log, by its stamped project (031): `audit.<action>`. */
const audit = (s: SourceScope) =>
  qb
    .selectFrom("audit_log as l")
    .leftJoin("sessions as s", (j) =>
      j.on(
        "s.id",
        "=",
        sql<string>`CASE WHEN instr(l.actor, 'session:') = 1 THEN substr(l.actor, 9) END`,
      ),
    )
    .leftJoin("tickets as t", (j) =>
      j.on("l.target_kind", "=", "ticket").onRef("t.id", "=", "l.target_id"),
    )
    .where("l.workspace_id", "=", s.workspaceId)
    .select(
      row({
        source: "audit",
        key: padded(ref("l.id")),
        ts: ref("l.ts"),
        kind: sql`'audit.' || l.action`,
        actor: ref("l.actor"),
        agent_id: sql`coalesce(s.agent_id, CASE WHEN l.target_kind = 'agent' THEN l.target_id END)`,
        ticket_id: sql`CASE WHEN l.target_kind = 'ticket' THEN l.target_id END`,
        ticket_num: ref("t.num"),
        session_id: sql`coalesce(s.id, CASE WHEN l.target_kind = 'session' THEN l.target_id END)`,
        summary: sql`l.action || coalesce(' ' || l.target_kind || coalesce(' ' || coalesce(${keyOf(s, "t.num")}, l.target_id), ''), '')`,
        payload_json: small(ref("l.payload_json")),
      }),
    );

/** ticket_events of the project's tickets: `ticket.<kind>`. */
const ticketEvents = (s: SourceScope) =>
  qb
    .selectFrom("ticket_events as e")
    .innerJoin("tickets as t", "t.id", "e.ticket_id")
    .leftJoin("sessions as s", (j) =>
      j.on("e.actor_kind", "=", "session").onRef("s.id", "=", "e.actor_id"),
    )
    .where("t.workspace_id", "=", s.workspaceId)
    .select(
      row({
        source: "ticket",
        key: padded(ref("e.id")),
        ts: ref("e.ts"),
        kind: sql`'ticket.' || e.kind`,
        // actorLabel's form: `operator`, or `<kind>:<id>`.
        actor: sql`CASE WHEN e.actor_kind = 'operator' OR e.actor_id IS NULL THEN e.actor_kind ELSE e.actor_kind || ':' || e.actor_id END`,
        agent_id: ref("s.agent_id"),
        ticket_id: ref("e.ticket_id"),
        ticket_num: ref("t.num"),
        session_id: sql`CASE WHEN e.actor_kind = 'session' THEN e.actor_id END`,
        summary: sql`${keyOf(s, "t.num")} || ' ' || e.kind || coalesce(' ' || e.from_status, '') || coalesce(' -> ' || e.to_status, '') || coalesce(': ' || e.reason, '')`,
        payload_json: small(ref("e.payload_json")),
      }),
    );

/** Sessions of the project: the session's own workspace, else its agent's. */
const sessionsOf = (s: SourceScope) =>
  qb
    .selectFrom("sessions as s")
    .innerJoin("agents as a", "a.id", "s.agent_id")
    .leftJoin("tickets as t", "t.id", "s.ticket_id")
    .where(
      (eb) => eb.fn.coalesce("s.workspace_id", "a.workspace_id"),
      "=",
      s.workspaceId,
    );

const sessionStarted = (s: SourceScope) =>
  sessionsOf(s)
    .where("s.started_at", "is not", null)
    .select(
      row({
        source: "session",
        key: sql`s.id || ':started'`,
        ts: ref("s.started_at"),
        kind: sql`'session.started'`,
        actor: sql`'supervisor'`,
        agent_id: ref("s.agent_id"),
        ticket_id: ref("s.ticket_id"),
        ticket_num: ref("t.num"),
        session_id: ref("s.id"),
        summary: sql`a.name || ' started ' || s.role || ' (' || s.run_class || ')' || coalesce(' on ' || ${keyOf(s, "t.num")}, '')`,
      }),
    );

const sessionEnded = (s: SourceScope) =>
  sessionsOf(s)
    .where("s.ended_at", "is not", null)
    .select(
      row({
        source: "session",
        key: sql`s.id || ':ended'`,
        ts: ref("s.ended_at"),
        kind: sql`'session.ended'`,
        actor: sql`'supervisor'`,
        agent_id: ref("s.agent_id"),
        ticket_id: ref("s.ticket_id"),
        ticket_num: ref("t.num"),
        session_id: ref("s.id"),
        summary: sql`a.name || ' ended ' || s.role || ': ' || s.state || coalesce(' (' || s.exit_reason || ')', '') || ', ' || s.turns || ' turns, $' || printf('%.2f', s.cost_usd) || coalesce(' on ' || ${keyOf(s, "t.num")}, '')`,
      }),
    );

/**
 * Pulses of the project's agents, at their scheduled time: `pulse.<state>`. Scoped by `agent_id IN`
 * the project's agents, not by the join, so the read goes through pulses_agent_idx per agent instead
 * of scanning every project's pulses.
 */
const pulses = (s: SourceScope) =>
  qb
    .selectFrom("pulses as p")
    .innerJoin("agents as a", "a.id", "p.agent_id")
    .where("p.agent_id", "in", (eb) =>
      eb
        .selectFrom("agents")
        .select("id")
        .where("workspace_id", "=", s.workspaceId),
    )
    .select(
      row({
        source: "pulse",
        key: ref("p.id"),
        ts: ref("p.scheduled_at"),
        kind: sql`'pulse.' || p.state`,
        actor: sql`'supervisor'`,
        agent_id: ref("p.agent_id"),
        ticket_id: sql`NULL`,
        ticket_num: sql`NULL`,
        session_id: ref("p.session_id"),
        summary: sql`a.name || ' pulse (' || p."trigger" || '): ' || p.state || coalesce(' - ' || p.skip_reason, '') || coalesce(': ' || p.summary_md, '')`,
      }),
    );

/** Gates on the project's tickets, one row each, at their start: `gate.<gate kind>`. */
const gates = (s: SourceScope) =>
  qb
    .selectFrom("gates as g")
    .innerJoin("tickets as t", "t.id", "g.ticket_id")
    .leftJoin("sessions as r", "r.id", "g.reviewer_session_id")
    .where("t.workspace_id", "=", s.workspaceId)
    .where("g.started_at", "is not", null)
    .select(
      row({
        source: "gate",
        key: ref("g.id"),
        ts: ref("g.started_at"),
        kind: sql`'gate.' || g.kind`,
        actor: sessionActor(ref("g.reviewer_session_id")),
        agent_id: ref("r.agent_id"),
        ticket_id: ref("g.ticket_id"),
        ticket_num: ref("t.num"),
        session_id: ref("g.reviewer_session_id"),
        summary: sql`g.kind || ' gate on ' || ${keyOf(s, "t.num")} || ' (attempt ' || g.attempt || ', round ' || g.round || '): ' || g.state`,
      }),
    );

/** Findings on the project's tickets (finding → gate → ticket), at filing: `finding.<severity>`. */
const findings = (s: SourceScope) =>
  qb
    .selectFrom("findings as f")
    .innerJoin("gates as g", "g.id", "f.gate_id")
    .innerJoin("tickets as t", "t.id", "g.ticket_id")
    .leftJoin("sessions as r", "r.id", "g.reviewer_session_id")
    .where("t.workspace_id", "=", s.workspaceId)
    .select(
      row({
        source: "finding",
        key: ref("f.id"),
        ts: ref("f.created_at"),
        kind: sql`'finding.' || f.severity`,
        actor: sessionActor(ref("g.reviewer_session_id")),
        agent_id: ref("r.agent_id"),
        ticket_id: ref("g.ticket_id"),
        ticket_num: ref("t.num"),
        session_id: ref("g.reviewer_session_id"),
        summary: sql`f.severity || ' finding on ' || ${keyOf(s, "t.num")} || coalesce(' ' || f.file || coalesce(':' || f.line, ''), '') || ': ' || f.summary || ' [' || f.status || ']'`,
      }),
    );

/** Hand-offs on the project's tickets, at creation: `handoff.<reason>`. */
const handoffs = (s: SourceScope) =>
  qb
    .selectFrom("handoffs as h")
    .innerJoin("tickets as t", "t.id", "h.ticket_id")
    .leftJoin("sessions as f", "f.id", "h.from_session_id")
    .where("t.workspace_id", "=", s.workspaceId)
    .select(
      row({
        source: "handoff",
        key: ref("h.id"),
        ts: ref("h.created_at"),
        kind: sql`'handoff.' || h.reason`,
        actor: sessionActor(ref("h.from_session_id")),
        agent_id: ref("f.agent_id"),
        ticket_id: ref("h.ticket_id"),
        ticket_num: ref("t.num"),
        session_id: ref("h.from_session_id"),
        summary: sql`'hand-off on ' || ${keyOf(s, "t.num")} || ' (' || h.reason || coalesce(', ' || h.phase_from || ' -> ' || h.phase_to, '') || CASE WHEN h.accepted_at IS NULL THEN ', pending)' ELSE ', accepted)' END || coalesce(': ' || h.goal_line, '')`,
      }),
    );

/** Human requests of the project: the ticket's workspace, else the asking session's project. */
const requestsOf = (s: SourceScope) =>
  qb
    .selectFrom("human_requests as r")
    .leftJoin("tickets as t", "t.id", "r.ticket_id")
    .leftJoin("sessions as s", "s.id", "r.session_id")
    .leftJoin("agents as a", "a.id", "s.agent_id")
    .where(
      (eb) =>
        eb.fn.coalesce("t.workspace_id", "s.workspace_id", "a.workspace_id"),
      "=",
      s.workspaceId,
    );

const requestAsked = (s: SourceScope) =>
  requestsOf(s).select(
    row({
      source: "human_request",
      key: sql`r.id || ':asked'`,
      ts: ref("r.asked_at"),
      kind: sql`'human_request.asked'`,
      actor: sessionActor(ref("r.session_id")),
      agent_id: ref("s.agent_id"),
      ticket_id: ref("r.ticket_id"),
      ticket_num: ref("t.num"),
      session_id: ref("r.session_id"),
      summary: sql`r.kind || ' asked' || coalesce(' on ' || ${keyOf(s, "t.num")}, '') || ': ' || r.question`,
    }),
  );

const requestAnswered = (s: SourceScope) =>
  requestsOf(s)
    .where("r.answered_at", "is not", null)
    .select(
      row({
        source: "human_request",
        key: sql`r.id || ':answered'`,
        ts: ref("r.answered_at"),
        kind: sql`'human_request.answered'`,
        actor: sql`coalesce(r.answered_by, 'supervisor')`,
        agent_id: ref("s.agent_id"),
        ticket_id: ref("r.ticket_id"),
        ticket_num: ref("t.num"),
        session_id: ref("r.session_id"),
        // The answer is stored as JSON text; a string answer shows as its text.
        // A dismissed question closes too, with no answer: its entry says so.
        summary: sql`r.kind || CASE WHEN r.status = 'dismissed' THEN ' dismissed' ELSE ' answered' END || coalesce(' on ' || ${keyOf(s, "t.num")}, '') || coalesce(': ' || CASE WHEN json_valid(r.answer_json) AND json_type(r.answer_json) = 'text' THEN json_extract(r.answer_json, '$') ELSE r.answer_json END, '')`,
      }),
    );

/** Every source's parts: a source with two moments (a start and an end) has two. */
export const TIMELINE_PARTS = [
  { source: "audit", build: audit },
  { source: "ticket", build: ticketEvents },
  { source: "session", build: sessionStarted },
  { source: "session", build: sessionEnded },
  { source: "pulse", build: pulses },
  { source: "gate", build: gates },
  { source: "finding", build: findings },
  { source: "handoff", build: handoffs },
  { source: "human_request", build: requestAsked },
  { source: "human_request", build: requestAnswered },
] as const;
