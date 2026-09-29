import { ADDABLE_AGENT_KINDS } from "@bayon/core";
import { z } from "zod";

// `POST /projects/:id/agents` and `PATCH /agents/:id`: the operator adds a builder, a
// reviewer or an orchestrator — at most one enabled per project, else 409 — to a project
// on a runner of its choosing, and enables, disables or resizes an agent.
// Nothing deletes an agent — `enabled: false` retires one — and neither door sets its mission,
// kind, runner or project after the fact.

const rowId = z.string().min(1).max(64);

/** Slots: 0, like `enabled: false`, is admission's `disabled` (as `frm agent set` takes it). */
const MaxConcurrency = z.int().min(0);

export const CreateProjectAgentRequest = z.strictObject({
  kind: z.enum(ADDABLE_AGENT_KINDS),
  runner_id: rowId,
  /** Absent: the column's default, 1. */
  max_concurrency: MaxConcurrency.optional(),
});
export type CreateProjectAgentRequest = z.infer<
  typeof CreateProjectAgentRequest
>;

export const PatchAgentRequest = z
  .strictObject({
    enabled: z.boolean().optional(),
    max_concurrency: MaxConcurrency.optional(),
  })
  .refine(
    (p) => p.enabled !== undefined || p.max_concurrency !== undefined,
    "set at least one of enabled, max_concurrency",
  );
export type PatchAgentRequest = z.infer<typeof PatchAgentRequest>;

/** One agent, as both doors answer. */
export const AgentView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  runner_id: z.string(),
  profile_id: z.string().nullable(),
  /** The project; null for a fleet agent. */
  workspace_id: z.string().nullable(),
  /** Where it runs: a new one takes its project's oldest agent's (null: the workspace's default). */
  executor_id: z.string().nullable(),
  max_concurrency: z.int().nonnegative(),
  enabled: z.boolean(),
});
export type AgentView = z.infer<typeof AgentView>;
