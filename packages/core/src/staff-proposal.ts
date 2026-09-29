import { z } from "zod";
import { StaffRole } from "./staffing.js";

// A staffing proposal: what an orchestrator's `ticket_staff` files instead of starting
// anyone when its ticket's project requires the operator's approval. A human_requests row of its
// own kind, keyed by the ticket's phase, answered `approve` or `reject`. Pure: the API's writers
// read and write the rows.

/** `human_requests.kind` of a staffing proposal. */
export const STAFF_APPROVAL_KIND = "staff_approval";

/** The operator's answer to a proposal: its options, in order. */
export const StaffDecision = z.enum(["approve", "reject"]);
export type StaffDecision = z.infer<typeof StaffDecision>;

/** `human_requests.proposal_json`: who the proposal would staff, in which role, for which phase. */
export const StaffProposal = z.strictObject({
  agent_id: z.string().min(1),
  runner_id: z.string().min(1),
  role: StaffRole,
  run_class: z.string().min(1),
  /** The pending hand-off the session would take over; null when the ticket had none. */
  handoff_id: z.string().min(1).nullable(),
});
export type StaffProposal = z.infer<typeof StaffProposal>;

/**
 * The proposal's dedupe key: one per ticket, role and phase (its run class and hand-off). The
 * unique index on `human_requests.dedupe_key` (014) holds forever, so the phase is in the key —
 * a later phase proposes again, while the same phase, once rejected, stays rejected.
 */
export const staffProposalKey = (
  ticketId: string,
  p: Pick<StaffProposal, "role" | "run_class" | "handoff_id">,
): string =>
  `staff:${ticketId}:${p.role}:${p.run_class}:${p.handoff_id ?? "-"}`;

/** The inbox question: who, on which ticket, as what. */
export const staffProposalQuestion = (
  ticketKey: string,
  p: Pick<StaffProposal, "agent_id" | "role" | "run_class">,
): string =>
  `Staff ${ticketKey} with ${p.agent_id} (${p.role}, ${p.run_class})?`;

/** The request's context: what approving and rejecting each do. */
export const staffProposalContext = (
  p: Pick<StaffProposal, "runner_id" | "handoff_id">,
): string =>
  [
    `Runner: ${p.runner_id}. Hand-off: ${p.handoff_id ?? "none"}.`,
    "Approve starts the session now, if the agent is still free; reject records the decision, and this phase is not proposed again.",
  ].join("\n");

/** An answer's text as a decision (case and surrounding space ignored), or null. */
export function staffDecisionOf(answer: string): StaffDecision | null {
  const parsed = StaffDecision.safeParse(answer.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}
