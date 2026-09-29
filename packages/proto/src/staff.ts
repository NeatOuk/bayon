import { StaffRole } from "@bayon/core";
import { z } from "zod";

// Staffing a ticket (§12.1 POST /tickets/:id/staff; the operator's twin of ticket_staff, §11.1):
// the run class comes from the ticket's status and the agent from the selection rule, among the
// ticket's project's agents (M2 amendment h), so the operator names the role and, when
// they want a particular one of those agents, the agent.

const Id = z.string().min(1);

export const StaffRequest = z.strictObject({
  role: StaffRole,
  /** An agent id: taken if it may work the ticket (its project, kind, enabled, a free slot). */
  agent: Id.max(64).optional(),
});
export type StaffRequest = z.infer<typeof StaffRequest>;

/** The session.spawn command staffing inserted; `created` is false for a repeated key. */
export const StaffAccepted = z.object({
  command_id: Id,
  session_id: Id,
  created: z.boolean(),
  agent_id: Id,
  role: StaffRole,
  run_class: Id,
  /** The pending hand-off the session takes over, if the ticket had one. */
  handoff_id: Id.nullable(),
  ticket_status: z.string(),
});
export type StaffAccepted = z.infer<typeof StaffAccepted>;

/**
 * A staffing proposal: what `ticket_staff` answers, as data rather than a refusal, when
 * the ticket's project requires the operator's approval. Nothing was started; the operator's answer
 * to request `request_id` in the inbox staffs `agent_id`, or rejects the phase. `created` is false
 * when the phase's proposal was already open.
 */
export const StaffProposed = z.object({
  status: z.literal("approval_pending"),
  request_id: Id,
  created: z.boolean(),
  agent_id: Id,
  role: StaffRole,
  run_class: Id,
  handoff_id: Id.nullable(),
  detail: z.string(),
});
export type StaffProposed = z.infer<typeof StaffProposed>;
