import {
  err,
  ok,
  type FrmError,
  type Result,
  type StaffRefusalReason,
} from "@bayon/core";
import type { StaffOutcome } from "@bayon/db/api";
import {
  SessionSpawnPayload,
  StaffAccepted,
  StaffProposed,
} from "@bayon/proto";
import { z } from "zod";

// Staffing as the API returns it (M2 amendment h): the spawn it queued, or the refusal each caller
// shapes for itself: ticket_staff as an MCP refusal, POST /tickets/:id/staff as an HTTP error. A
// proposal (`approval_pending`) is a refusal to REST and data to ticket_staff.

export type StaffResult =
  | { readonly kind: "staffed"; readonly accepted: StaffAccepted }
  | {
      readonly kind: "refused";
      readonly reason: StaffRefusalReason;
      readonly detail: string;
      /** `approval_pending` only: the proposal filed, or still open, for the operator. */
      readonly proposal?: StaffProposed;
    };

const internal = (message: string): FrmError => ({
  class: "internal",
  message,
  retryable: false,
});

/** A refusal as the API returns it; `approval_pending`'s proposal checked against its DTO. */
function refusedResult(
  outcome: Extract<StaffOutcome, { kind: "refused" }>,
): Result<StaffResult> {
  const { reason, detail, proposal } = outcome;
  if (reason !== "approval_pending")
    return ok({ kind: "refused", reason, detail });
  const parsed = StaffProposed.safeParse({
    status: reason,
    request_id: proposal?.request_id,
    created: proposal?.created,
    agent_id: proposal?.agent_id,
    role: proposal?.role,
    run_class: proposal?.run_class,
    handoff_id: proposal?.handoff_id,
    detail,
  });
  return parsed.success
    ? ok({ kind: "refused", reason, detail, proposal: parsed.data })
    : err(
        internal(
          `approval_pending does not fit StaffProposed: ${z.prettifyError(parsed.error)}`,
        ),
      );
}

export function staffResult(outcome: StaffOutcome): Result<StaffResult> {
  if (outcome.kind === "refused") return refusedResult(outcome);
  const spawn = SessionSpawnPayload.safeParse(outcome.payload);
  if (!spawn.success) {
    return err(
      internal(
        `command ${outcome.command_id} is not a session.spawn: ${z.prettifyError(spawn.error)}`,
      ),
    );
  }
  const p = spawn.data;
  const accepted = StaffAccepted.safeParse({
    command_id: outcome.command_id,
    session_id: p.session_id,
    created: outcome.created,
    agent_id: p.agent_id,
    role: p.role,
    run_class: p.run_class,
    handoff_id: p.handoff_id ?? null,
    ticket_status: outcome.ticket_status,
  });
  return accepted.success
    ? ok({ kind: "staffed", accepted: accepted.data })
    : err(
        internal(
          `command ${outcome.command_id} does not fit StaffAccepted: ${z.prettifyError(accepted.error)}`,
        ),
      );
}

/**
 * Each refusal as REST shapes it, exhaustively: a new reason must be placed here, not fall through
 * to some other status. A ticket that takes no session (or has one) is a 409 conflict; no budget or
 * no free agent is admission_refused (429), retryable once spend resets or a slot frees. A stale
 * holder's release is a conflict too — the ticket is still held as this call returns — but a
 * retryable one, because the hand-off it queued is what makes the next call land.
 *
 * `cross_project` is a 409, not retryable, rather than a 403: the caller is who it
 * says it is, and what refuses is a fact about the ticket (its project is not the caller's), as
 * with `not_staffable`; asking again changes nothing. The operator's own door never meets it.
 *
 * `approval_pending` is a 409, retryable. The operator's door never meets it either —
 * the operator's staffing needs no approval — but a caller that did started nothing (so not a 202:
 * there is no spawn to accept), and what stands in the way is a state of the ticket, its open
 * proposal, which the operator's answer changes: `holder_releasing`'s shape.
 *
 * `awaiting_human` is a 409, retryable, on the same grounds: a state of the ticket (an
 * open question to the operator) that the answer lifts. The operator's door never meets it either:
 * the operator's staffing overrides it, audited.
 */
const REST_REFUSAL: Readonly<
  Record<
    StaffRefusalReason,
    {
      readonly class: "conflict" | "admission_refused";
      readonly retryable: boolean;
    }
  >
> = {
  not_staffable: { class: "conflict", retryable: false },
  holder_releasing: { class: "conflict", retryable: true },
  cross_project: { class: "conflict", retryable: false },
  approval_pending: { class: "conflict", retryable: true },
  awaiting_human: { class: "conflict", retryable: true },
  over_budget: { class: "admission_refused", retryable: true },
  no_agent: { class: "admission_refused", retryable: true },
};

export const staffRefusalError = (r: {
  readonly reason: StaffRefusalReason;
  readonly detail: string;
}): FrmError => ({
  ...REST_REFUSAL[r.reason],
  message: `${r.reason}: ${r.detail}`,
});
