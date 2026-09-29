import {
  NOT_A_QUESTION_KIND,
  PULSE_RUN_CLASS,
  PULSE_WINDOW_MS,
  ok,
} from "@bayon/core";
import {
  all,
  first,
  qb,
  read,
  readSnapshot,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { sql, type ExpressionBuilder } from "kysely";
import type { AgentRow, DB } from "../schema.js";
import type { PulseRow } from "../schema-pulse.js";
import { HUMAN_ONLY_ARMS } from "../schema-work.js";
import { attentionAt } from "./attention.js";
import { getBudgetCap } from "./budget.js";
import { todayUsd, type FleetBudget } from "./fleet-overview.js";
import { openQuestionOn } from "./open-questions.js";
import {
  attentionInScope,
  projectTicketIds,
  pulseActionable,
  type PulseScope,
} from "./project-scope.js";
import { LIVE_PULSE_STATES } from "./pulses.js";

// What the pulse scheduler reads to decide: an agent's pulse history,
// the completions that wake it, the free no-op check, and the rows its sweep and gate need.

/** One agent's pulse history, as core's `PulseHistory` wants it, plus the no-op check's base. */
export interface PulseHistoryRow {
  readonly lastAt: number | null;
  readonly lastSeed: string | null;
  readonly lastRanAt: number | null;
  readonly ranAts: readonly number[];
  /** `scheduled_at` of the newest done pulse: completions since then are unserved. */
  readonly lastDoneAt: number | null;
}

/** `agentId`'s pulse history as of `now`. "Ran" means any state but skipped. */
export function pulseHistory(
  db: Db,
  agentId: string,
  now: number,
): R<PulseHistoryRow> {
  return readSnapshot(db, (ix) => {
    const mine = qb.selectFrom("pulses").where("agent_id", "=", agentId);
    const last = first(
      ix,
      mine
        .select(["id", "scheduled_at"])
        .where((eb) =>
          eb.not(
            eb.and([
              eb("state", "=", "skipped"),
              eb("skip_reason", "=", "rate_capped"),
            ]),
          ),
        )
        .orderBy("scheduled_at", "desc")
        .orderBy("id", "desc")
        .limit(1),
    );
    const newest = (state: "ran" | "done") =>
      first(
        ix,
        mine
          .select("scheduled_at")
          .$if(state === "ran", (b) => b.where("state", "<>", "skipped"))
          .$if(state === "done", (b) => b.where("state", "=", "done"))
          .orderBy("scheduled_at", "desc")
          .limit(1),
      )?.scheduled_at ?? null;
    const ranAts = all(
      ix,
      mine
        .select("scheduled_at")
        .where("state", "<>", "skipped")
        .where("scheduled_at", ">", now - PULSE_WINDOW_MS),
    ).map((r) => r.scheduled_at);
    return {
      lastAt: last?.scheduled_at ?? null,
      lastSeed: last?.id ?? null,
      lastRanAt: newest("ran"),
      ranAts,
      lastDoneAt: newest("done"),
    };
  });
}

/** What wakes an on_idle/hybrid agent (§9.7). Pending hand-offs reach it through the view. */
export const COMPLETION_KINDS = [
  "session_exited",
  "human_answered",
  "gate_decided",
] as const;
export type CompletionKind = (typeof COMPLETION_KINDS)[number];

export interface Completion {
  readonly kind: CompletionKind;
  /** The row: a session, a human request or a gate. */
  readonly ref: string;
  readonly at: number;
  /** Its ticket's project, or null (no project, or no ticket): whose orchestrators it wakes. */
  readonly workspace_id: string | null;
}

/** Where a completions poll resumes: after `(at, ref)`, so same-millisecond rows are not lost. */
export interface CompletionCursor {
  readonly at: number;
  readonly ref: string;
}

const COMPLETIONS_LIMIT = 200;

/**
 * Completions after `since`, oldest first, at most 200, each with its ticket's project.
 * `session_exited` counts ticket sessions only: a pulse's own session (no ticket) or the exporter
 * never wakes a pulse.
 */
export function completionsSince(
  db: Db,
  since: CompletionCursor,
  kinds: readonly CompletionKind[] = COMPLETION_KINDS,
): R<Completion[]> {
  return readSnapshot(db, (ix) =>
    completionRows(ix, since, kinds, COMPLETIONS_LIMIT, null),
  );
}

/** Its ticket's project, as a completion row's `workspace_id` (a correlated subquery). */
const workspaceOf = (
  eb: ExpressionBuilder<DB, "sessions" | "human_requests" | "gates">,
  ticketColumn:
    "sessions.ticket_id" | "human_requests.ticket_id" | "gates.ticket_id",
) =>
  eb
    .selectFrom("tickets as wt")
    .select("wt.workspace_id")
    .whereRef("wt.id", "=", ticketColumn)
    .as("workspace_id");

/**
 * Not a ticket waiting on an answer: a session's end or a gate's decision on a ticket with
 * an open question is not pulse work — nothing the pulse does for it can land until the operator
 * answers, and the answer is a completion of its own. A row with no ticket always counts.
 */
const notOnWaitingTicket = (ticketColumn: string) =>
  sql<boolean>`NOT EXISTS ${openQuestionOn(ticketColumn)}`;

/**
 * An answer that wakes: its ticket's last — no question on the ticket is still open, and
 * none was closed after it — so answering one of two wakes nobody and the last wakes once. A
 * dismissal closes a question as an answer does, and wakes the same way. A staffing proposal's
 * answer and a request with no ticket wake as they always did.
 */
const lastAnswer = sql<boolean>`(
  human_requests.kind = ${NOT_A_QUESTION_KIND}
  OR human_requests.ticket_id IS NULL
  OR (
    NOT EXISTS ${openQuestionOn("human_requests.ticket_id")}
    AND NOT EXISTS (
      SELECT 1 FROM human_requests AS la
      WHERE la.ticket_id = human_requests.ticket_id
        AND la.kind <> ${NOT_A_QUESTION_KIND}
        AND la.status <> 'open'
        AND (la.answered_at > human_requests.answered_at
             OR (la.answered_at = human_requests.answered_at AND la.id > human_requests.id))
    )
  )
)`;

/** `scope` null: the fleet's completions; else only those whose ticket is in its project. */
function completionRows(
  ix: Internals,
  since: CompletionCursor,
  kinds: readonly CompletionKind[],
  limit: number,
  scope: PulseScope | null,
): Completion[] {
  const rows: Completion[] = [];
  const add = (
    kind: CompletionKind,
    found: readonly {
      ref: string;
      at: number | null;
      workspace_id: string | null;
    }[],
  ) => {
    for (const r of found)
      if (r.at !== null)
        rows.push({ kind, ref: r.ref, at: r.at, workspace_id: r.workspace_id });
  };
  if (kinds.includes("session_exited")) {
    add(
      "session_exited",
      all(
        ix,
        qb
          .selectFrom("sessions")
          .select(["id as ref", "ended_at as at"])
          .select((eb) => workspaceOf(eb, "sessions.ticket_id"))
          .where("ticket_id", "is not", null)
          .where(notOnWaitingTicket("sessions.ticket_id"))
          .$call((b) =>
            scope === null
              ? b
              : b.where("ticket_id", "in", projectTicketIds(scope.workspaceId)),
          )
          .where((eb) =>
            eb.or([
              eb("ended_at", ">", since.at),
              eb.and([eb("ended_at", "=", since.at), eb("id", ">", since.ref)]),
            ]),
          )
          .orderBy("ended_at")
          .orderBy("id")
          .limit(limit),
      ),
    );
  }
  if (kinds.includes("human_answered")) {
    add(
      "human_answered",
      all(
        ix,
        qb
          .selectFrom("human_requests")
          .select(["id as ref", "answered_at as at"])
          .select((eb) => workspaceOf(eb, "human_requests.ticket_id"))
          .where(lastAnswer)
          .$call((b) =>
            scope === null
              ? b
              : b.where("ticket_id", "in", projectTicketIds(scope.workspaceId)),
          )
          .where((eb) =>
            eb.or([
              eb("answered_at", ">", since.at),
              eb.and([
                eb("answered_at", "=", since.at),
                eb("id", ">", since.ref),
              ]),
            ]),
          )
          .orderBy("answered_at")
          .orderBy("id")
          .limit(limit),
      ),
    );
  }
  if (kinds.includes("gate_decided")) {
    add(
      "gate_decided",
      all(
        ix,
        qb
          .selectFrom("gates")
          .select(["id as ref", "decided_at as at"])
          .select((eb) => workspaceOf(eb, "gates.ticket_id"))
          .where(notOnWaitingTicket("gates.ticket_id"))
          .$call((b) =>
            scope === null
              ? b
              : b.where("ticket_id", "in", projectTicketIds(scope.workspaceId)),
          )
          .where((eb) =>
            eb.or([
              eb("decided_at", ">", since.at),
              eb.and([
                eb("decided_at", "=", since.at),
                eb("id", ">", since.ref),
              ]),
            ]),
          )
          .orderBy("decided_at")
          .orderBy("id")
          .limit(limit),
      ),
    );
  }
  return rows
    .toSorted(
      (a, b) => a.at - b.at || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
    )
    .slice(0, limit);
}

/**
 * §9.7's free no-op check, before a single token: anything on v_needs_attention (which covers
 * unread messages and pending hand-offs) but the arms only a human can act on, or any completion
 * since `sinceAt`. With a scope, only its project's rows and completions count, and its
 * own unread mail: another project's work never costs this orchestrator a pulse. A ticket whose
 * staffing proposal is open is the operator's until they answer: its staffing rows do
 * not count, and the answer is a completion. So is a ticket with an open question: none
 * of its work rows, session ends or gate decisions count, and only its last answer wakes.
 */
export function hasPulseWork(
  db: Db,
  sinceAt: number,
  scope: PulseScope | null = null,
): R<boolean> {
  return readSnapshot(
    db,
    (ix) =>
      first(
        ix,
        qb
          .selectFrom(attentionAt(ix.clock.now()).as("v"))
          .select("v.why")
          .where("v.why", "not in", HUMAN_ONLY_ARMS)
          .where(pulseActionable)
          .$call((b) => (scope === null ? b : b.where(attentionInScope(scope))))
          .limit(1),
      ) !== undefined ||
      completionRows(ix, { at: sinceAt, ref: "" }, COMPLETION_KINDS, 1, scope)
        .length > 0,
  );
}

/** Every pulse holding a lease, oldest first: the sweep's work list. */
export function listLivePulses(db: Db): R<PulseRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("pulses")
        .selectAll()
        .where("state", "in", LIVE_PULSE_STATES)
        .orderBy("scheduled_at")
        .orderBy("id"),
    ),
  );
}

/** The agents that pulse: enabled orchestrators, by id. */
export function listPulseAgents(db: Db): R<AgentRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("agents")
        .selectAll()
        .where("kind", "=", "orchestrator")
        .where("enabled", "=", 1)
        .orderBy("id"),
    ),
  );
}

/**
 * The pulse a session serves, for `spend.pulse_id` (§8.9), or null. Only a session of the pulse
 * run class reaches `pulses`, which has no session_id index.
 */
export function pulseIdForSession(db: Db, sessionId: string): R<string | null> {
  return read(
    db,
    (ix) =>
      first(
        ix,
        qb
          .selectFrom("sessions as s")
          .innerJoin("pulses as p", "p.session_id", "s.id")
          .select("p.id")
          .where("s.id", "=", sessionId)
          .where("s.run_class", "=", PULSE_RUN_CLASS)
          .orderBy("p.scheduled_at", "desc")
          .limit(1),
      )?.id ?? null,
  );
}

/** Today's spend (UTC) against `budget.daily_cap_usd`: the M2 pulse gate's check (amendment f). */
export async function getDailyBudget(db: Db): R<FleetBudget> {
  const cap = await getBudgetCap(db);
  if (!cap.ok) return cap;
  const today = await read(db, (ix) => todayUsd(ix, ix.clock.now()));
  if (!today.ok) return today;
  return ok({ today_usd: today.value, daily_cap_usd: cap.value });
}
