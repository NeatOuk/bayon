import { STAFF_APPROVAL_KIND } from "@bayon/core";
import {
  sql,
  type Expression,
  type ExpressionBuilder,
  type SqlBool,
} from "kysely";
import { qb } from "../connection.js";
import type { DB } from "../schema.js";
import type { AttentionWhy, NeedsAttentionRow } from "../schema-work.js";
import { openQuestionOn } from "./open-questions.js";

// What an orchestrator with a project reads: the pulse's no-op check, its completions
// and its context pack all take this one scope, so a project's orchestrator neither wakes for nor
// is shown another project's work. An orchestrator with no project reads the fleet, as before.

/** The attention rows (`attentionAt(now)`) aliased `v`, as every scoped attention read selects them. */
type AttentionAsV = DB & { readonly v: NeedsAttentionRow };

/** A project's orchestrator's view. Null where a scope is taken: the fleet's. */
export interface PulseScope {
  /** The project (workspace): only its tickets' rows are the orchestrator's. */
  readonly workspaceId: string;
  /** The agent's name, which mail is addressed to: its own unread mail is its, whatever the ticket. */
  readonly agentName: string;
}

/** An agent row's scope: its project and name, or null (the fleet) when it has no project. */
export const pulseScopeOf = (agent: {
  readonly name: string;
  readonly workspace_id: string | null;
}): PulseScope | null =>
  agent.workspace_id === null
    ? null
    : { workspaceId: agent.workspace_id, agentName: agent.name };

/** The ids of the project's tickets: `<ticket column> IN (…)` keeps a row to the project. */
export const projectTicketIds = (workspaceId: string) =>
  qb.selectFrom("tickets").select("id").where("workspace_id", "=", workspaceId);

/** The ids of the unread messages to `agentName`. */
const unreadMailTo = (agentName: string) =>
  qb
    .selectFrom("messages")
    .select("id")
    .where("to_kind", "=", "agent")
    .where("to_id", "=", agentName)
    .where("read_at", "is", null);

/**
 * A v_needs_attention row (aliased `v`) is the scope's when its ticket is in the project, or when it
 * is unread mail to the agent. Rows with no ticket (the fleet's budget, executors, backups, a pulse's
 * own session) are the operator's, not a project's.
 */
export const attentionInScope =
  (scope: PulseScope) =>
  (eb: ExpressionBuilder<AttentionAsV, "v">): Expression<SqlBool> =>
    eb.or([
      eb("v.ticket_id", "in", projectTicketIds(scope.workspaceId)),
      eb.and([
        eb("v.why", "=", "unread_message"),
        eb("v.ref", "in", unreadMailTo(scope.agentName)),
      ]),
    ]);

/**
 * The arms a staffing proposal stands for: each asks the orchestrator to staff its
 * ticket, and while the ticket's proposal is open that ask is already with the operator.
 */
export const PROPOSED_ARMS = [
  "unstaffed_ready",
  "handoff_pending",
  "spawn_failed",
] as const satisfies readonly AttentionWhy[];

/** The open staffing proposals on the ticket `ticketColumn` names (the ticket_id, status index). */
const openProposalOn = (ticketColumn: string) =>
  qb
    .selectFrom("human_requests as hr")
    .select("hr.id")
    .where("hr.ticket_id", "=", sql.ref<string>(ticketColumn))
    .where("hr.status", "=", "open")
    .where("hr.kind", "=", STAFF_APPROVAL_KIND);

/**
 * A v_needs_attention row (aliased `v`) the pulse still counts: any row but a PROPOSED_ARMS row of a
 * ticket with an open staffing proposal. Without it, every pulse of an approval project
 * would wake for, and re-staff, the ticket its last pulse proposed. The pulse side only: the view,
 * and so the operator's attention strip, still lists the row.
 */
export const notAwaitingApproval = <D, T extends keyof D>(
  eb: ExpressionBuilder<D, T>,
): Expression<SqlBool> =>
  eb.or([
    eb(sql.ref<string>("v.why"), "not in", [...PROPOSED_ARMS]),
    eb.not(eb.exists(openProposalOn("v.ticket_id"))),
  ]);

/**
 * The arms that ask the orchestrator to act on a row's ticket: staff it, re-staff it, fix it, split
 * it. While the ticket has an open question none of them is the orchestrator's to act
 * on — the ticket is the operator's until they answer — so none is pulse work. `unread_message` is
 * not among them: mail is addressed to an agent, and the orchestrator's own still reaches it. Nor is
 * `gate_stuck`: since an earlier change it is the operator's whatever the ticket (HUMAN_ONLY_ARMS).
 */
export const ANSWER_WAIT_ARMS = [
  "stale_session",
  "handoff_pending",
  "unstaffed_ready",
  "findings_open",
  "split_candidate",
  "spawn_failed",
] as const satisfies readonly AttentionWhy[];

/**
 * A v_needs_attention row (aliased `v`) that is not waiting on an answer: any row but an
 * ANSWER_WAIT_ARMS row of a ticket with an open question. Without it, each hand-off of a
 * builder that asked and could go no further was pulse work, and the pulse staffed a successor that
 * found the same open questions, asked them again and handed off: the FRM-82 loop.
 */
export const notAwaitingAnswer = <D, T extends keyof D>(
  eb: ExpressionBuilder<D, T>,
): Expression<SqlBool> =>
  eb.or([
    eb(sql.ref<string>("v.why"), "not in", [...ANSWER_WAIT_ARMS]),
    eb.not(eb.exists(openQuestionOn("v.ticket_id"))),
  ]);

/**
 * A v_needs_attention row (aliased `v`) the pulse acts on: not waiting on the operator, neither for
 * a staffing proposal's answer nor for a question's. The pulse's no-op check
 * and the context pack's work lists read this one predicate; the view, and so the operator's
 * attention strip, still lists every row.
 */
export const pulseActionable = <D, T extends keyof D>(
  eb: ExpressionBuilder<D, T>,
): Expression<SqlBool> =>
  eb.and([notAwaitingApproval(eb), notAwaitingAnswer(eb)]);
