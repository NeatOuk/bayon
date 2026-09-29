import { err, ok, type Result, type TicketStatus } from "@bayon/core";
import { sql } from "kysely";
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
import { ftsAnyQuery } from "../fts.js";
import type { PulseRow } from "../schema-pulse.js";
import type { AttentionWhy } from "../schema-work.js";
import { attentionAt } from "./attention.js";
import { dailyCap, todayUsd } from "./fleet-overview.js";
import { openQuestionOn } from "./open-questions.js";
import {
  attentionInScope,
  projectTicketIds,
  pulseActionable,
  pulseScopeOf,
  type PulseScope,
} from "./project-scope.js";
import { ENDED_STATES } from "./sessions.js";
import { keyPrefix } from "./ticket-key.js";

// The context pack's reads (§10.1): what one pulse's pack shows, in one snapshot. Every list has a
// stable order and a limit, and the day's spend is taken at the pulse's scheduled_at, never the
// clock, so the same database gives the same pack (§8.2). The supervisor renders and compiles it.
// An agent with a project reads only that project's rows (project-scope.ts). A ticket with
// an open staffing proposal shows it among the human requests, and not as staffing still to do
//: its unstaffed, pending hand-off and failed spawn rows wait on the operator. So does a
// ticket with an open question: its work rows leave the lists, its questions stay under
// the human requests, and its in-flight row counts the answers it waits on.

/** Each list's most rows (§10.1: newest 20 per attention group, top 10 knowledge). */
export const CONTEXT_PACK_LIMITS = {
  attentionPerGroup: 20,
  tickets: 40,
  handoffs: 20,
  messages: 20,
  humanRequests: 20,
  knowledge: 10,
  /** The open tickets whose title words search knowledge, and the most words searched. */
  searchTickets: 40,
  searchWords: 64,
} as const;
const L = CONTEXT_PACK_LIMITS;

/** Not in flight: not staffed yet, parked, or closed. */
const NOT_IN_FLIGHT = [
  "backlog",
  "prioritized",
  "parked",
  "done",
  "rejected",
  "split",
] as const satisfies readonly TicketStatus[];
/** Closed; any other status is open. */
const CLOSED = [
  "done",
  "rejected",
  "split",
] as const satisfies readonly TicketStatus[];

export interface PackCount {
  readonly key: string;
  readonly n: number;
}

/** The first rows of a list, and how many there are in all. */
export interface PackList<T> {
  readonly total: number;
  readonly rows: readonly T[];
}

export interface PackAttentionItem {
  readonly ref: string;
  readonly ticket_id: string | null;
  readonly ticket_num: number | null;
  readonly ticket_title: string | null;
}

/** One v_needs_attention arm: its newest rows (refs are ULIDs, so by ref) and its size. */
export interface PackAttentionGroup {
  readonly why: AttentionWhy;
  readonly total: number;
  readonly items: readonly PackAttentionItem[];
}

export interface PackTicket {
  readonly num: number;
  readonly title: string;
  readonly status: string;
  readonly priority: number;
  readonly created_at: number;
  readonly blocked_reason: string | null;
  readonly owner_agent: string | null;
  readonly owner_role: string | null;
  /** It has a pending hand-off (v_needs_attention's handoff_pending arm). */
  readonly handoff_pending: boolean;
  /** Its open questions to the operator: while any is open, it waits on them. */
  readonly open_questions: number;
}

export interface PackHandoff {
  readonly id: string;
  readonly ticket_num: number;
  readonly ticket_title: string;
  readonly quality: string;
  readonly goal_line: string | null;
  readonly next_steps_md: string | null;
  readonly created_at: number;
  /** The role its predecessor session ran as (sessions.role): what staffing the successor uses. */
  readonly from_role: string | null;
}

export interface PackMessage {
  readonly id: string;
  readonly ts: number;
  readonly from_kind: string;
  readonly from_id: string;
  readonly subject: string;
  readonly body_md: string;
  readonly ticket_num: number | null;
}

export interface PackHumanRequest {
  readonly id: string;
  readonly asked_at: number;
  readonly kind: string;
  readonly question: string;
  readonly ticket_num: number | null;
}

export type PackPulse = Pick<
  PulseRow,
  "id" | "trigger" | "state" | "scheduled_at" | "summary_md" | "actions_json"
>;

export interface PackKnowledge {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body_md: string;
}

export interface ContextPackInputs {
  readonly agent: { readonly id: string; readonly name: string };
  /**
   * The agent's project, or null: the fleet. With one, every list below is that
   * project's alone (its tickets' rows, and the agent's own mail); the budget is still the fleet's.
   */
  readonly project: { readonly id: string; readonly name: string } | null;
  /** settings.tickets.key_prefix, else the default when absent or malformed: tickets' keys. */
  readonly key_prefix: string;
  /** The agent's current mission (agents.mission_id); null before the first. */
  readonly mission: {
    readonly version: number;
    readonly rendered_md: string;
  } | null;
  readonly pulse: PackPulse;
  /** This pulse's number among the agent's pulses that ran: skipped ones do not count. */
  readonly seq: number;
  /** The newest earlier pulse that ran, or null. */
  readonly previous: PackPulse | null;
  /** Spend on the pulse's UTC day, and the daily cap (null: none). */
  readonly budget: {
    readonly today_usd: number;
    readonly daily_cap_usd: number | null;
  };
  /** Live sessions by state, and tickets by status. */
  readonly sessions: readonly PackCount[];
  readonly ticket_statuses: readonly PackCount[];
  readonly attention: readonly PackAttentionGroup[];
  /** Most urgent first: priority, then the latest update. */
  readonly tickets: PackList<PackTicket>;
  /** v_needs_attention's handoff_pending arm (the one pending predicate), newest first. */
  readonly handoffs: PackList<PackHandoff>;
  /** Unread messages to this agent, newest first. */
  readonly messages: PackList<PackMessage>;
  /** Open human requests, newest first. */
  readonly human_requests: PackList<PackHumanRequest>;
  /** The best entries by FTS rank against the open tickets' titles. */
  readonly knowledge: readonly PackKnowledge[];
  /** Every probe's untrusted_output flag, by name. */
  readonly probes: readonly {
    readonly name: string;
    readonly untrusted_output: number;
  }[];
}

const QueryShape = z.object({
  agentId: z.string().min(1),
  pulseId: z.string().min(1),
});
export type ContextPackQuery = z.input<typeof QueryShape>;

/**
 * Everything a pulse's context pack shows, read in one snapshot. An unknown pulse is `not_found`;
 * a pulse of another agent is `validation`.
 */
export async function getContextPackInputs(
  db: Db,
  query: ContextPackQuery,
): R<ContextPackInputs> {
  const parsed = QueryShape.safeParse(query);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `bad context pack query: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { agentId, pulseId } = parsed.data;
  const found = await readSnapshot(db, (ix) => gather(ix, agentId, pulseId));
  return found.ok ? found.value : found;
}

const PULSE_COLUMNS = [
  "id",
  "trigger",
  "state",
  "scheduled_at",
  "summary_md",
  "actions_json",
] as const;

/** A `count(*) AS n` row's count. */
const countOf = (row: { readonly n: number } | undefined): number =>
  row?.n ?? 0;

function gather(
  ix: Internals,
  agentId: string,
  pulseId: string,
): Result<ContextPackInputs> {
  const row = first(
    ix,
    qb
      .selectFrom("pulses")
      .select([...PULSE_COLUMNS, "agent_id"])
      .where("id", "=", pulseId),
  );
  if (row === undefined) {
    return err(failure("not_found", `pulse ${pulseId} does not exist`));
  }
  if (row.agent_id !== agentId) {
    return err(
      failure("validation", `pulse ${pulseId} is not agent ${agentId}'s`),
    );
  }
  const agent = first(
    ix,
    qb
      .selectFrom("agents")
      .select(["id", "name", "mission_id", "workspace_id"])
      .where("id", "=", agentId),
  );
  if (agent === undefined) {
    return err(failure("not_found", `agent ${agentId} does not exist`));
  }
  const cap = dailyCap(ix);
  if (!cap.ok) return cap;
  const before = ranBefore(row);
  const scope = pulseScopeOf(agent);
  return ok({
    agent: { id: agent.id, name: agent.name },
    project: projectOf(ix, scope),
    key_prefix: keyPrefix(ix),
    mission: missionOf(ix, agent.mission_id),
    pulse: {
      id: row.id,
      trigger: row.trigger,
      state: row.state,
      scheduled_at: row.scheduled_at,
      summary_md: row.summary_md,
      actions_json: row.actions_json,
    },
    seq:
      countOf(
        first(
          ix,
          before.select((eb) => eb.fn.countAll<number>().as("n")),
        ),
      ) + 1,
    previous:
      first(
        ix,
        before
          .select(PULSE_COLUMNS)
          .orderBy("scheduled_at", "desc")
          .orderBy("id", "desc")
          .limit(1),
      ) ?? null,
    budget: {
      today_usd: todayUsd(ix, row.scheduled_at),
      daily_cap_usd: cap.value,
    },
    ...counts(ix, scope),
    attention: attentionGroups(ix, scope),
    tickets: ticketsInFlight(ix, scope),
    handoffs: pendingHandoffs(ix, scope),
    messages: unreadMessages(ix, agent.name),
    human_requests: openHumanRequests(ix, scope),
    knowledge: knowledgeFor(ix, scope),
    probes: all(
      ix,
      qb
        .selectFrom("probes")
        .select(["name", "untrusted_output"])
        .orderBy("name"),
    ),
  });
}

/** The scope's project as the pack names it: its id and name (the id again if the row is gone). */
function projectOf(
  ix: Internals,
  scope: PulseScope | null,
): ContextPackInputs["project"] {
  if (scope === null) return null;
  const id = scope.workspaceId;
  const row = first(
    ix,
    qb.selectFrom("workspaces").select("name").where("id", "=", id),
  );
  return { id, name: row?.name ?? id };
}

function missionOf(
  ix: Internals,
  missionId: string | null,
): ContextPackInputs["mission"] {
  if (missionId === null) return null;
  return (
    first(
      ix,
      qb
        .selectFrom("missions")
        .select(["version", "rendered_md"])
        .where("id", "=", missionId),
    ) ?? null
  );
}

/** The agent's pulses that ran and were scheduled before `p` (a tie goes by id). */
const ranBefore = (p: Pick<PulseRow, "id" | "agent_id" | "scheduled_at">) =>
  qb
    .selectFrom("pulses")
    .where("agent_id", "=", p.agent_id)
    .where("state", "<>", "skipped")
    .where((eb) =>
      eb.or([
        eb("scheduled_at", "<", p.scheduled_at),
        eb.and([eb("scheduled_at", "=", p.scheduled_at), eb("id", "<", p.id)]),
      ]),
    );

/** Live sessions by state, and tickets by status: a scope's are on its project's tickets. */
function counts(
  ix: Internals,
  scope: PulseScope | null,
): Pick<ContextPackInputs, "sessions" | "ticket_statuses"> {
  return {
    sessions: all(
      ix,
      qb
        .selectFrom("sessions")
        .select("state as key")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("state", "not in", ENDED_STATES)
        .$call((b) =>
          scope === null
            ? b
            : b.where("ticket_id", "in", projectTicketIds(scope.workspaceId)),
        )
        .groupBy("state")
        .orderBy("state"),
    ),
    ticket_statuses: all(
      ix,
      qb
        .selectFrom("tickets")
        .select("status as key")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .$call((b) =>
          scope === null ? b : b.where("workspace_id", "=", scope.workspaceId),
        )
        .groupBy("status")
        .orderBy("status"),
    ),
  };
}

function attentionGroups(
  ix: Internals,
  scope: PulseScope | null,
): PackAttentionGroup[] {
  const ranked = qb
    .selectFrom(attentionAt(ix.clock.now()).as("v"))
    .where(pulseActionable)
    .$call((b) => (scope === null ? b : b.where(attentionInScope(scope))))
    .leftJoin("tickets as t", "t.id", "v.ticket_id")
    .select([
      "v.why",
      "v.ref",
      "v.ticket_id",
      "t.num as ticket_num",
      "t.title as ticket_title",
      sql<number>`row_number() OVER (PARTITION BY v.why ORDER BY v.ref DESC, v.ticket_id DESC)`.as(
        "rank",
      ),
      sql<number>`count(*) OVER (PARTITION BY v.why)`.as("total"),
    ]);
  const rows = all(
    ix,
    qb
      .selectFrom(ranked.as("r"))
      .selectAll()
      .where("rank", "<=", L.attentionPerGroup)
      .orderBy("why")
      .orderBy("rank"),
  );
  return [...new Set(rows.map((r) => r.why))].map((why) => {
    const items = rows.filter((r) => r.why === why);
    return {
      why,
      total: items[0]?.total ?? 0,
      items: items.map((r) => ({
        ref: r.ref,
        ticket_id: r.ticket_id,
        ticket_num: r.ticket_num,
        ticket_title: r.ticket_title,
      })),
    };
  });
}

function ticketsInFlight(
  ix: Internals,
  scope: PulseScope | null,
): PackList<PackTicket> {
  const inFlight = qb
    .selectFrom("tickets as t")
    .where("t.status", "not in", NOT_IN_FLIGHT)
    .$call((b) =>
      scope === null ? b : b.where("t.workspace_id", "=", scope.workspaceId),
    );
  return {
    total: countOf(
      first(
        ix,
        inFlight.select((eb) => eb.fn.countAll<number>().as("n")),
      ),
    ),
    rows: all(
      ix,
      inFlight
        .leftJoin("sessions as s", "s.id", "t.owner_session_id")
        .leftJoin("agents as a", "a.id", "s.agent_id")
        .select([
          "t.num",
          "t.title",
          "t.status",
          "t.priority",
          "t.created_at",
          "t.blocked_reason",
          "a.name as owner_agent",
          "s.role as owner_role",
        ])
        .select((eb) =>
          eb
            .exists(
              eb
                .selectFrom(attentionAt(ix.clock.now()).as("v"))
                .innerJoin("handoffs as h", "h.id", "v.ref")
                .select("v.ref")
                .where("v.why", "=", "handoff_pending")
                .where(pulseActionable)
                .whereRef("h.ticket_id", "=", "t.id"),
            )
            .as("handoff_pending"),
        )
        .select((eb) =>
          eb
            .selectFrom(openQuestionOn("t.id").as("q"))
            .select((q) => q.fn.countAll<number>().as("n"))
            .as("open_questions"),
        )
        .orderBy("t.priority")
        .orderBy("t.updated_at", "desc")
        .orderBy("t.num")
        .limit(L.tickets),
    ).map((t) => ({
      ...t,
      handoff_pending: Boolean(t.handoff_pending),
      open_questions: t.open_questions ?? 0,
    })),
  };
}

function pendingHandoffs(
  ix: Internals,
  scope: PulseScope | null,
): PackList<PackHandoff> {
  const pending = qb
    .selectFrom(attentionAt(ix.clock.now()).as("v"))
    .innerJoin("handoffs as h", "h.id", "v.ref")
    .innerJoin("tickets as t", "t.id", "h.ticket_id")
    .where("v.why", "=", "handoff_pending")
    .where(pulseActionable)
    .$call((b) =>
      scope === null ? b : b.where("t.workspace_id", "=", scope.workspaceId),
    );
  return {
    total: countOf(
      first(
        ix,
        pending.select((eb) => eb.fn.countAll<number>().as("n")),
      ),
    ),
    rows: all(
      ix,
      pending
        .leftJoin("sessions as s", "s.id", "h.from_session_id")
        .select([
          "h.id",
          "t.num as ticket_num",
          "t.title as ticket_title",
          "h.quality",
          "h.goal_line",
          "h.next_steps_md",
          "h.created_at",
          "s.role as from_role",
        ])
        .orderBy("h.created_at", "desc")
        .orderBy("h.id", "desc")
        .limit(L.handoffs),
    ),
  };
}

function unreadMessages(
  ix: Internals,
  agentName: string,
): PackList<PackMessage> {
  const unread = qb
    .selectFrom("messages as m")
    .leftJoin("tickets as t", "t.id", "m.ticket_id")
    .where("m.to_kind", "=", "agent")
    .where("m.to_id", "=", agentName)
    .where("m.read_at", "is", null);
  return {
    total: countOf(
      first(
        ix,
        unread.select((eb) => eb.fn.countAll<number>().as("n")),
      ),
    ),
    rows: all(
      ix,
      unread
        .select([
          "m.id",
          "m.ts",
          "m.from_kind",
          "m.from_id",
          "m.subject",
          "m.body_md",
          "t.num as ticket_num",
        ])
        .orderBy("m.ts", "desc")
        .orderBy("m.id", "desc")
        .limit(L.messages),
    ),
  };
}

function openHumanRequests(
  ix: Internals,
  scope: PulseScope | null,
): PackList<PackHumanRequest> {
  const open = qb
    .selectFrom("human_requests as h")
    .leftJoin("tickets as t", "t.id", "h.ticket_id")
    .where("h.status", "=", "open")
    .$call((b) =>
      scope === null ? b : b.where("t.workspace_id", "=", scope.workspaceId),
    );
  return {
    total: countOf(
      first(
        ix,
        open.select((eb) => eb.fn.countAll<number>().as("n")),
      ),
    ),
    rows: all(
      ix,
      open
        .select([
          "h.id",
          "h.asked_at",
          "h.kind",
          "h.question",
          "t.num as ticket_num",
        ])
        .orderBy("h.asked_at", "desc")
        .orderBy("h.id", "desc")
        .limit(L.humanRequests),
    ),
  };
}

/** The best knowledge for the open tickets' titles: a scope's own tickets only. */
function knowledgeFor(
  ix: Internals,
  scope: PulseScope | null,
): PackKnowledge[] {
  const titles = all(
    ix,
    qb
      .selectFrom("tickets")
      .select("title")
      .where("status", "not in", CLOSED)
      .$call((b) =>
        scope === null ? b : b.where("workspace_id", "=", scope.workspaceId),
      )
      .orderBy("priority")
      .orderBy("updated_at", "desc")
      .orderBy("num")
      .limit(L.searchTickets),
  ).map((t) => t.title);
  const match = ftsAnyQuery(titles, L.searchWords);
  if (match === null) return [];
  return all(
    ix,
    qb
      .selectFrom("knowledge_fts")
      .innerJoin("knowledge", "knowledge.id", "knowledge_fts.ref")
      .select([
        "knowledge.id",
        "knowledge.kind",
        "knowledge.title",
        "knowledge.body_md",
      ])
      .where(sql.ref("knowledge_fts"), "match", match)
      .orderBy(sql`knowledge_fts.rank`)
      .orderBy("knowledge.id")
      .limit(L.knowledge),
  );
}
