import {
  STAFF_APPROVAL_KIND,
  StaffDecision,
  err,
  ok,
  type FrmError,
  type Result,
  type StaffProposal,
  type StaffRefusalReason,
} from "@bayon/core";
import { z } from "zod";
import { requireText } from "../checks.js";
import {
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { casMiss, failure } from "../errors.js";
import type { HumanRequestRow } from "../schema-work.js";
import { audited, type AuditEntry } from "./audit.js";
import { storedProposal } from "./staff-proposal.js";
import { staffIn, type StaffOutcome } from "./staffing.js";
import { checkActor, type TicketActor } from "./ticket-common.js";
import type { Decide } from "./ticket-transition.js";

// The operator's answer to a staffing proposal (`POST /inbox/:id/answer` on a request of
// kind `staff_approval`). One transaction: the request is answered, and an approval staffs the
// proposed agent as the operator — so the answer stands only if the staffing does. A refusal (the
// agent is busy or disabled, the ticket is held or no longer staffable) or a phase that moved on
// since the proposal is returned as an error, and write() rolls the answer back: the request stays
// open for the operator to approve later or reject. A rejection records the answer only.

const OPEN = "open";
const ANSWERED = "answered";

export interface StaffProposalAnswer {
  /** The request's id. */
  readonly id: string;
  readonly decision: StaffDecision;
  /** Who answered, as the request records it. */
  readonly answered_by: string;
  /** Who an approval staffs as: the operator, whose staffing never needs approval. */
  readonly by: TicketActor;
}

export interface StaffProposalAnswered {
  readonly request: HumanRequestRow;
  readonly decision: StaffDecision;
  /** An approval's session.spawn; null for a rejection. */
  readonly command_id: string | null;
}

/** Refusals the fleet's next change can lift: approving again may then land. */
const RETRYABLE: ReadonlySet<StaffRefusalReason> = new Set([
  "no_agent",
  "over_budget",
  "holder_releasing",
]);

/** A staffing refusal as the approval's error: a conflict naming the reason, the request open. */
const refusedApproval = (
  id: string,
  r: Extract<StaffOutcome, { kind: "refused" }>,
): FrmError => ({
  class: "conflict",
  message: `proposal ${id} cannot be staffed now (${r.reason}: ${r.detail}); it stays open — approve it again later, or reject it`,
  retryable: RETRYABLE.has(r.reason),
  cause: { reason: r.reason, detail: r.detail },
});

const Spawned = z.object({
  run_class: z.string(),
  handoff_id: z.string().optional(),
});

/**
 * Whether the spawn is the proposal's phase: its run class and hand-off. The ticket may have moved
 * since (the operator re-planned it, a hand-off arrived), and an approval is of what was proposed.
 */
function samePhase(
  id: string,
  proposal: StaffProposal,
  payload: unknown,
): Result<void> {
  const spawned = Spawned.safeParse(payload);
  if (!spawned.success) {
    return err(failure("internal", `proposal ${id}'s spawn has no run class`));
  }
  const handoff = spawned.data.handoff_id ?? null;
  if (
    spawned.data.run_class === proposal.run_class &&
    handoff === proposal.handoff_id
  ) {
    return ok(undefined);
  }
  return err({
    class: "conflict",
    message: `proposal ${id} is for run class ${proposal.run_class} (hand-off ${proposal.handoff_id ?? "none"}), but the ticket now asks for ${spawned.data.run_class} (hand-off ${handoff ?? "none"}); reject it`,
    retryable: false,
  });
}

interface OpenProposal {
  readonly ticketId: string;
  readonly proposal: StaffProposal;
}

/** The request, open and a staffing proposal: its ticket and what it proposes; else why not. */
function openProposal(ix: Internals, id: string): Result<OpenProposal> {
  const row = first(
    ix,
    qb.selectFrom("human_requests").selectAll().where("id", "=", id),
  );
  if (row === undefined) {
    return err(failure("not_found", `human request ${id} does not exist`));
  }
  if (row.kind !== STAFF_APPROVAL_KIND || row.ticket_id === null) {
    return err(
      failure("validation", `human request ${id} is not a staffing proposal`),
    );
  }
  if (row.status !== OPEN) {
    return casMiss(`human request ${id}`, { state: row.status }, [OPEN]);
  }
  const proposal = storedProposal(id, row.proposal_json);
  return proposal.ok
    ? ok({ ticketId: row.ticket_id, proposal: proposal.value })
    : proposal;
}

function answerIn(
  ix: Internals,
  a: StaffProposalAnswer,
  decide: Decide,
  audit: AuditEntry | undefined,
): Result<StaffProposalAnswered> {
  const open = openProposal(ix, a.id);
  if (!open.ok) return open;
  const { ticketId, proposal } = open.value;
  const answered = first(
    ix,
    qb
      .updateTable("human_requests")
      .set({
        status: ANSWERED,
        answer_json: JSON.stringify(a.decision),
        answered_by: a.answered_by,
        answered_at: ix.clock.now(),
      })
      .where("id", "=", a.id)
      .where("status", "=", OPEN)
      .returningAll(),
  );
  if (answered === undefined) {
    return err(failure("internal", `human request ${a.id} was not answered`));
  }
  if (a.decision === "reject") {
    return audited(
      ix,
      ok({ request: answered, decision: a.decision, command_id: null }),
      audit,
    );
  }
  const staffed = staffIn(
    ix,
    {
      ticket_id: ticketId,
      role: proposal.role,
      by: a.by,
      idempotencyKey: `approval:${a.id}`,
      agent: proposal.agent_id,
    },
    decide,
  );
  if (!staffed.ok) return staffed;
  if (staffed.value.kind === "refused") {
    return err(refusedApproval(a.id, staffed.value));
  }
  const phase = samePhase(a.id, proposal, staffed.value.payload);
  if (!phase.ok) return phase;
  return audited(
    ix,
    ok({
      request: answered,
      decision: a.decision,
      command_id: staffed.value.command_id,
    }),
    audit,
  );
}

/**
 * Answers staffing proposal `a.id`: `approve` staffs the proposed agent in the same transaction,
 * `reject` records the answer. Refused, writing nothing: an unknown request (not_found), one that
 * is not a proposal (validation), one already answered (conflict), and an approval whose staffing
 * is refused or whose phase moved on (conflict, the reason in its cause). Either answer sets
 * `answered_at`, the `human_answered` completion that wakes the orchestrator.
 */
export async function answerStaffProposal(
  db: Db,
  a: StaffProposalAnswer,
  decide: Decide,
  audit?: AuditEntry,
): R<StaffProposalAnswered> {
  const checked = requireText({ id: a.id, answered_by: a.answered_by });
  if (!checked.ok) return checked;
  const actor = checkActor(a.by);
  if (!actor.ok) return actor;
  const decision = StaffDecision.safeParse(a.decision);
  if (!decision.success) {
    return err(
      failure("validation", `a proposal is answered approve or reject`),
    );
  }
  if (a.by.actor_kind === "session") {
    return err(
      failure("validation", "only the operator answers a staffing proposal"),
    );
  }
  return write(db, (ix) => answerIn(ix, a, decide, audit));
}
