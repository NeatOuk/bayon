import {
  STAFF_APPROVAL_KIND,
  StaffDecision,
  StaffProposal,
  canonicalJson,
  err,
  newId,
  ok,
  staffProposalContext,
  staffProposalKey,
  staffProposalQuestion,
  ticketKey,
  type Result,
  type StaffRole,
} from "@bayon/core";
import { z } from "zod";
import { execute, first, qb, type Internals } from "../connection.js";
import { failure } from "../errors.js";
import type { TicketRow } from "../schema.js";
import type { Candidate } from "./staffing-scope.js";
import {
  actorColumns,
  insertTicketEvent,
  type TicketActor,
} from "./ticket-common.js";
import { keyPrefix } from "./ticket-key.js";

// A project's approval of its orchestrator's staffing, inside staffTicket's transaction:
// when a session staffs in a project with `staff_approval` on, nothing starts — the phase's proposal
// is filed (a human_requests row of kind `staff_approval`, with a `staff_proposed` ticket_event), or
// the one already filed for it answers. human_requests is the API's to write (§9.5); staffing is an
// API writer, and the operator's answer is `answerStaffProposal`'s.

const OPEN = "open";

/** A proposal as staffing reports it: the request, and what it proposes. */
export interface ProposalFiled extends StaffProposal {
  readonly request_id: string;
  /** False when the phase's proposal was already open: nothing was written. */
  readonly created: boolean;
}

/** What staffing does next: start the session, or stop at the proposal. */
export type ProposalStep =
  /** No approval is required, or the operator approved this phase: staff it. */
  | { readonly kind: "proceed" }
  /** Filed now, or still open: the operator decides. */
  | { readonly kind: "pending"; readonly filed: ProposalFiled }
  /** The operator rejected this phase's proposal. */
  | {
      readonly kind: "rejected";
      readonly request_id: string;
      readonly answer: string;
    };

export interface ProposalAsk {
  readonly ticket: TicketRow;
  readonly by: TicketActor;
  readonly role: StaffRole;
  readonly runClass: string;
  readonly handoffId: string | null;
  /** The agent staffing picked (or the caller named). */
  readonly agent: Candidate;
}

/**
 * Whether the caller's staffing needs the operator's approval: a session's (only an orchestrator
 * reaches `ticket_staff`; any session is held to it, fail-closed), never the operator's, in a
 * project with `staff_approval` on. The project is the ticket's, or for a ticket with none the
 * agent's, which staffing would pin it to: an unscoped ticket does not skip it.
 */
function approvalRequired(ix: Internals, a: ProposalAsk): boolean {
  if (a.by.actor_kind !== "session") return false;
  const project = a.ticket.workspace_id ?? a.agent.workspace_id;
  if (project === null) return false;
  const row = first(
    ix,
    qb
      .selectFrom("workspaces")
      .select("staff_approval")
      .where("id", "=", project),
  );
  return row?.staff_approval === 1;
}

const Answer = z.string();

/** A request's answer_json as its text; the raw column when it is not a JSON string. */
function answerText(answerJson: string | null): string {
  if (answerJson === null) return "";
  try {
    const parsed = Answer.safeParse(JSON.parse(answerJson));
    return parsed.success ? parsed.data : answerJson;
  } catch {
    return answerJson;
  }
}

/** A stored proposal, checked: a row this writer filed always parses. */
export function storedProposal(
  id: string,
  json: string | null,
): Result<StaffProposal> {
  let value: unknown;
  try {
    value = JSON.parse(json ?? "null");
  } catch {
    return err(failure("internal", `proposal ${id} is not JSON`));
  }
  const parsed = StaffProposal.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        failure(
          "internal",
          `proposal ${id} is malformed: ${z.prettifyError(parsed.error)}`,
        ),
      );
}

/** Files the phase's proposal: the request, and the ticket_event that records it. */
function file(
  ix: Internals,
  a: ProposalAsk,
  proposal: StaffProposal,
  key: string,
): ProposalFiled {
  const now = ix.clock.now();
  const id = newId(now);
  const question = staffProposalQuestion(
    ticketKey(keyPrefix(ix), a.ticket.num),
    proposal,
  );
  execute(
    ix,
    qb.insertInto("human_requests").values({
      id,
      session_id: a.by.actor_id,
      ticket_id: a.ticket.id,
      kind: STAFF_APPROVAL_KIND,
      question,
      context_md: staffProposalContext(proposal),
      options_json: JSON.stringify(StaffDecision.options),
      batch_id: null,
      status: OPEN,
      asked_at: now,
      expires_at: null,
      dedupe_key: key,
      proposal_json: canonicalJson(proposal),
    }),
  );
  insertTicketEvent(ix, {
    ticket_id: a.ticket.id,
    ts: now,
    ...actorColumns(a.by),
    kind: "staff_proposed",
    from_status: null,
    to_status: null,
    reason: question,
    payload_json: canonicalJson({ human_request_id: id, ...proposal }),
  });
  return { ...proposal, request_id: id, created: true };
}

/**
 * The approval step of a staffing, after the agent is picked and before anything moves. By the
 * phase's key: no row files one (pending, created); an open one is pending again, writing nothing;
 * one answered `approve` proceeds (a retry of the approved phase — its spawn failed); any other
 * answer is the operator's rejection.
 */
export function proposalStep(
  ix: Internals,
  a: ProposalAsk,
): Result<ProposalStep> {
  if (!approvalRequired(ix, a)) return ok({ kind: "proceed" });
  const proposal: StaffProposal = {
    agent_id: a.agent.id,
    runner_id: a.agent.runner_id,
    role: a.role,
    run_class: a.runClass,
    handoff_id: a.handoffId,
  };
  const key = staffProposalKey(a.ticket.id, proposal);
  const earlier = first(
    ix,
    qb
      .selectFrom("human_requests")
      .select(["id", "status", "answer_json", "proposal_json"])
      .where("dedupe_key", "=", key),
  );
  if (earlier === undefined) {
    return ok({ kind: "pending", filed: file(ix, a, proposal, key) });
  }
  if (earlier.status === OPEN) {
    const stored = storedProposal(earlier.id, earlier.proposal_json);
    if (!stored.ok) return stored;
    return ok({
      kind: "pending",
      filed: { ...stored.value, request_id: earlier.id, created: false },
    });
  }
  const answer = answerText(earlier.answer_json);
  return answer === "approve"
    ? ok({ kind: "proceed" })
    : ok({ kind: "rejected", request_id: earlier.id, answer });
}
