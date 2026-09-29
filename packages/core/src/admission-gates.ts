// Admission's closed enums, in a leaf module: gates/schemas.ts reads
// QueuedReason for GateFailure, and admission.ts reads gates/settings.ts, so neither imports the
// other's module graph. admission.ts re-exports all of it.
import { z } from "zod";
import type { RunnerCaps } from "./runner-caps.js";

/**
 * The §5.1 capability the `runner_concurrency` gate enforces, and the one conformance test 15 is
 * gated on (`GATING_CAP`). One constant, read from both ends: test 15's N/A is honest only while
 * admission serialises the runner that declared the cap absent (§15), so the two may not drift.
 */
export const SINGLE_SESSION_CAP: keyof RunnerCaps = "concurrentSessions";

/** Every gate, in the order admission evaluates them. */
export const AdmissionGate = z.enum([
  "disabled",
  "no_model",
  /** A work role's session would mount none of its MCP tools, so it could not write back. */
  "no_tools",
  /**
   * The run class's context cap is below the runner's session baseline: a session with the
   * runner's own tools could not start inside it.
   */
  "context_baseline",
  "trust",
  "uncertified",
  "fleet_paused",
  /**
   * The session's project (its workspace, else its agent's) is paused (`workspaces.paused`,
   *): its spawn waits and its next turn is held; other projects run on.
   */
  "project_paused",
  "budget",
  "disk",
  "retry_storm",
  "concurrency",
  /**
   * The runner declares `concurrentSessions` absent and one of its sessions is already live: its
   * credential serves one at a time, so the next spawn waits for it (§5.1).
   */
  "runner_concurrency",
  "unhealthy",
  "slot",
]);
export type AdmissionGate = z.infer<typeof AdmissionGate>;

/** `sessions.queued_reason`: the gates that keep a spawn pending until they clear. */
export const QueuedReason = AdmissionGate.exclude([
  "disabled",
  "no_model",
  "no_tools",
  "context_baseline",
  "trust",
  "uncertified",
]);
export type QueuedReason = z.infer<typeof QueuedReason>;

/** Which run a live session starts: only `run` is checked. */
export const TurnKind = z.enum(["first", "run", "handoff"]);
export type TurnKind = z.infer<typeof TurnKind>;

/** `admission_refused`'s cause. */
export const AdmissionRefusalCause = z.object({
  gate: AdmissionGate,
  detail: z.string(),
});
export type AdmissionRefusalCause = z.infer<typeof AdmissionRefusalCause>;
