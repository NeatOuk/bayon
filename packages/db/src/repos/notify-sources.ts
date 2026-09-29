import {
  ticketKey,
  type ArmRow,
  type BudgetMoment,
  type JiraFailMoment,
  type NotifyTicket,
  type QaHumanMoment,
  type RequestMoment,
  type RunnerUpdateMoment,
} from "@bayon/core";
import { sql, type SqlBool } from "kysely";
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
import { HUMAN_ONLY_ARMS } from "../schema-work.js";
import { attentionAt } from "./attention.js";
import { openRunnerUpdatesIn } from "./runner-updates.js";
import { keyPrefix } from "./ticket-key.js";

// What the notifier reads each tick: the rows past its watermarks on the three tables
// moments land in, and the human-only attention arms standing now, all in one snapshot, so a block
// and the request it filed (one transaction) are never read apart. Reads only: human_requests,
// ticket_events and audit_log are other writers' tables; the notifier writes its own outbox.

/** The tables the notifier keeps a watermark on, by rowid (ticket_events and audit_log: their id). */
export const NOTIFY_SOURCES = [
  "human_requests",
  "ticket_events",
  "audit_log",
] as const;
export type NotifySource = (typeof NOTIFY_SOURCES)[number];
export type NotifyCursors = Readonly<Partial<Record<NotifySource, number>>>;

/** The most rows one tick reads from a source; the watermark then stops at the last one read. */
export const NOTIFY_SOURCE_LIMIT = 500;

const BLOCK_ACTION = "supervisor.block_ticket";
const JIRA_ACTION = "jira.sync";

export interface BlockRow {
  readonly auditId: number;
  readonly ticket: NotifyTicket | null;
  readonly reason: string;
  /** The request the block filed, folded into its notification. */
  readonly requestId: string | null;
  readonly question: string | null;
}

export interface NotifySourceRows {
  /** Each source's watermark as stored; a missing one is a first boot for that source. */
  readonly cursors: NotifyCursors;
  /** Where each source's watermark moves to once these rows are filed. */
  readonly advance: Readonly<Record<NotifySource, number>>;
  /** Requests past the watermark still open, staffing proposals included (kind says which). */
  readonly requests: readonly RequestMoment[];
  readonly qaHuman: readonly QaHumanMoment[];
  readonly blocks: readonly BlockRow[];
  /** Failed syncs whose project's previous sync did not fail (or was the first). */
  readonly jiraFailures: readonly JiraFailMoment[];
  /** Budgets on the budget_warn arm now. */
  readonly budgets: readonly BudgetMoment[];
  /** The other human-only arms standing now, one row each; the collector groups them. */
  readonly arms: readonly ArmRow[];
  /** Open runner update checks: a newer release, not dismissed, standing state like `arms`. */
  readonly runnerUpdates: readonly RunnerUpdateMoment[];
}

const OPEN = "open";
const rowid = (table: string) => sql<number>`${sql.ref(table)}.rowid`;

/** The newest rowid of each source now. */
function heads(ix: Internals): Record<NotifySource, number> {
  const max = (table: NotifySource) =>
    first(
      ix,
      qb.selectFrom(table).select(sql<number | null>`max(rowid)`.as("head")),
    )?.head ?? 0;
  return {
    human_requests: max("human_requests"),
    ticket_events: max("ticket_events"),
    audit_log: max("audit_log"),
  };
}

function storedCursors(ix: Internals): NotifyCursors {
  const rows = all(
    ix,
    qb.selectFrom("notification_cursors").select(["source", "last_seen"]),
  );
  const known: readonly string[] = NOTIFY_SOURCES;
  return Object.fromEntries(
    rows
      .filter((r) => known.includes(r.source))
      .map((r) => [r.source, r.last_seen]),
  );
}

/** Tickets by id, keyed as the settings' prefix names them. */
function ticketsById(
  ix: Internals,
  ids: readonly (string | null)[],
): ReadonlyMap<string, NotifyTicket> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const prefix = keyPrefix(ix);
  return new Map(
    all(
      ix,
      qb
        .selectFrom("tickets")
        .select(["id", "num", "title", "workspace_id"])
        .where("id", "in", wanted),
    ).map((t) => [t.id, { ...t, key: ticketKey(prefix, t.num) }]),
  );
}

const ticketOf = (
  tickets: ReadonlyMap<string, NotifyTicket>,
  id: string | null,
): NotifyTicket | null => (id === null ? null : (tickets.get(id) ?? null));

/** Rows `after` < rowid <= `head`, oldest first, at most the limit; and where the watermark moves. */
interface Window {
  readonly after: number;
  readonly head: number;
}
const moved = (w: Window, seqs: readonly number[]): number =>
  seqs.length >= NOTIFY_SOURCE_LIMIT ? (seqs.at(-1) ?? w.head) : w.head;

function requestsIn(ix: Internals, w: Window) {
  const rows = all(
    ix,
    qb
      .selectFrom("human_requests as h")
      .leftJoin("sessions as s", "s.id", "h.session_id")
      .leftJoin("agents as a", "a.id", "s.agent_id")
      .select([
        rowid("h").as("seq"),
        "h.id",
        "h.kind",
        "h.question",
        "h.status",
        "h.ticket_id",
        "s.workspace_id as session_workspace",
        "a.name as agent",
      ])
      .where(
        sql<SqlBool>`${rowid("h")} > ${w.after} AND ${rowid("h")} <= ${w.head}`,
      )
      .orderBy(rowid("h"))
      .limit(NOTIFY_SOURCE_LIMIT),
  );
  const tickets = ticketsById(
    ix,
    rows.map((r) => r.ticket_id),
  );
  const open = rows
    .filter((r) => r.status === OPEN)
    .map((r): RequestMoment => {
      const ticket = ticketOf(tickets, r.ticket_id);
      return {
        id: r.id,
        kind: r.kind,
        question: r.question,
        agent: r.agent,
        ticket,
        workspace_id: ticket?.workspace_id ?? r.session_workspace,
      };
    });
  return {
    open,
    advance: moved(
      w,
      rows.map((r) => r.seq),
    ),
  };
}

function qaHumanIn(ix: Internals, w: Window) {
  const rows = all(
    ix,
    qb
      .selectFrom("ticket_events")
      .select(["id", "ticket_id"])
      .where("id", ">", w.after)
      .where("id", "<=", w.head)
      .where("to_status", "=", "qa_human")
      .where((eb) =>
        eb.or([
          eb("from_status", "is", null),
          eb("from_status", "<>", "qa_human"),
        ]),
      )
      .orderBy("id")
      .limit(NOTIFY_SOURCE_LIMIT),
  );
  const tickets = ticketsById(
    ix,
    rows.map((r) => r.ticket_id),
  );
  const moments = rows.flatMap((r): QaHumanMoment[] => {
    const ticket = tickets.get(r.ticket_id);
    return ticket === undefined ? [] : [{ eventId: r.id, ticket }];
  });
  return {
    moments,
    advance: moved(
      w,
      rows.map((r) => r.id),
    ),
  };
}

const BlockPayload = z.object({
  blocked_reason: z.string().catch("the circuit breaker blocked it"),
  human_request_id: z.string().nullish().catch(null),
});
const JiraPayload = z.object({
  ok: z.boolean(),
  error: z.object({ message: z.string() }).optional().catch(undefined),
});

function json(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return null;
  }
}

function blockOf(
  ix: Internals,
  row: { id: number; target_id: string | null; payload_json: string | null },
  tickets: ReadonlyMap<string, NotifyTicket>,
): BlockRow {
  const p = BlockPayload.safeParse(json(row.payload_json));
  const requestId = p.success ? (p.data.human_request_id ?? null) : null;
  const question =
    requestId === null
      ? null
      : (first(
          ix,
          qb
            .selectFrom("human_requests")
            .select("question")
            .where("id", "=", requestId),
        )?.question ?? null);
  return {
    auditId: row.id,
    ticket: ticketOf(tickets, row.target_id),
    reason: p.success
      ? p.data.blocked_reason
      : "the circuit breaker blocked it",
    requestId,
    question,
  };
}

/** Whether the project's jira.sync before `beforeId` failed: only a first failure notifies. */
function previousSyncFailed(
  ix: Internals,
  workspaceId: string,
  beforeId: number,
): boolean {
  const prev = first(
    ix,
    qb
      .selectFrom("audit_log")
      .select("payload_json")
      .where("action", "=", JIRA_ACTION)
      .where("target_id", "=", workspaceId)
      .where("id", "<", beforeId)
      .orderBy("id", "desc")
      .limit(1),
  );
  if (prev === undefined) return false;
  const p = JiraPayload.safeParse(json(prev.payload_json));
  return p.success && !p.data.ok;
}

function auditIn(ix: Internals, w: Window) {
  const rows = all(
    ix,
    qb
      .selectFrom("audit_log")
      .select(["id", "action", "target_id", "payload_json"])
      .where("id", ">", w.after)
      .where("id", "<=", w.head)
      .where("action", "in", [BLOCK_ACTION, JIRA_ACTION])
      .orderBy("id")
      .limit(NOTIFY_SOURCE_LIMIT),
  );
  const tickets = ticketsById(
    ix,
    rows.filter((r) => r.action === BLOCK_ACTION).map((r) => r.target_id),
  );
  const blocks = rows
    .filter((r) => r.action === BLOCK_ACTION)
    .map((r) => blockOf(ix, r, tickets));
  const jiraFailures = rows.flatMap((r): JiraFailMoment[] => {
    if (r.action !== JIRA_ACTION || r.target_id === null) return [];
    const p = JiraPayload.safeParse(json(r.payload_json));
    if (!p.success || p.data.ok) return [];
    if (previousSyncFailed(ix, r.target_id, r.id)) return [];
    const ws = first(
      ix,
      qb.selectFrom("workspaces").select("name").where("id", "=", r.target_id),
    );
    return [
      {
        auditId: r.id,
        workspaceId: r.target_id,
        workspaceName: ws?.name ?? r.target_id,
        message: p.data.error?.message ?? "the sync failed",
      },
    ];
  });
  return {
    blocks,
    jiraFailures,
    advance: moved(
      w,
      rows.map((r) => r.id),
    ),
  };
}

/** The human-only arms standing now: the budget warnings apart, the rest as arms. */
function standing(ix: Internals) {
  const rows = all(
    ix,
    qb
      .selectFrom(attentionAt(ix.clock.now()).as("v"))
      .select(["why", "ref", "ticket_id"])
      .where("why", "in", HUMAN_ONLY_ARMS)
      .orderBy("why")
      .orderBy("ref"),
  );
  const budgetIds = rows
    .filter((r) => r.why === "budget_warn")
    .map((r) => r.ref);
  const budgets =
    budgetIds.length === 0
      ? []
      : all(
          ix,
          qb
            .selectFrom("budgets as b")
            .leftJoin("agents as a", "a.id", "b.scope_ref")
            .select([
              "b.id",
              "b.scope",
              "a.name as agent",
              "b.period",
              "b.cap_usd",
              "b.cap_tokens",
              "b.warn_pct",
            ])
            .where("b.id", "in", budgetIds)
            .orderBy("b.id"),
        );
  const others = rows.filter((r) => r.why !== "budget_warn");
  const tickets = ticketsById(
    ix,
    others.map((r) => r.ticket_id),
  );
  const arms = others.map((r): ArmRow => ({
    why: r.why,
    ref: r.ref,
    ticket: ticketOf(tickets, r.ticket_id),
  }));
  return { budgets, arms };
}

/**
 * One tick's reads, in one snapshot. A source with no watermark (first boot) reads nothing and its
 * watermark starts at its newest row, so history is never back-filled; the arms are state, read
 * whole each time.
 */
export async function notifySources(db: Db): R<NotifySourceRows> {
  return readSnapshot(db, (ix) => {
    const head = heads(ix);
    const cursors = storedCursors(ix);
    const window = (s: NotifySource): Window | null => {
      const after = cursors[s];
      return after === undefined
        ? null
        : { after, head: Math.max(after, head[s]) };
    };
    const wr = window("human_requests");
    const wt = window("ticket_events");
    const wa = window("audit_log");
    const requests = wr === null ? null : requestsIn(ix, wr);
    const qa = wt === null ? null : qaHumanIn(ix, wt);
    const audit = wa === null ? null : auditIn(ix, wa);
    const { budgets, arms } = standing(ix);
    return {
      cursors,
      advance: {
        human_requests: requests?.advance ?? head.human_requests,
        ticket_events: qa?.advance ?? head.ticket_events,
        audit_log: audit?.advance ?? head.audit_log,
      },
      requests: requests?.open ?? [],
      qaHuman: qa?.moments ?? [],
      blocks: audit?.blocks ?? [],
      jiraFailures: audit?.jiraFailures ?? [],
      budgets,
      arms,
      runnerUpdates: openRunnerUpdatesIn(ix).map((u) => ({
        runner_id: u.runner_id,
        current: u.current,
        latest: u.latest,
      })),
    };
  });
}
