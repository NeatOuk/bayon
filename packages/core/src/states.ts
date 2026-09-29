import { z } from "zod";

/** `sessions.state`: the session state machine of §3.3. */
export const SessionState = z.enum([
  "pending",
  "preparing",
  "spawning",
  "running",
  "idle",
  "awaiting_approval",
  "human_attached",
  "handoff_writing",
  "handed_off",
  "stopping",
  "exited",
  "resumable",
]);
export type SessionState = z.infer<typeof SessionState>;

/** `sessions.exit_reason`: the `exited{…}` outcomes of §3.3. */
export const ExitReason = z.enum([
  "ok",
  "error",
  "killed",
  "timeout",
  "abandoned",
]);
export type ExitReason = z.infer<typeof ExitReason>;

/** `runs.state` (§4). A run is one prompt through to its `terminal` event. */
export const RunState = z.enum([
  "running",
  "ok",
  "failed",
  "timeout",
  "interrupted",
  "budget_stop",
]);
export type RunState = z.infer<typeof RunState>;

/** `runs.trigger` (§4): what opened a run. */
export const RunTrigger = z.enum([
  "pulse",
  "operator",
  "orchestrator",
  "retry",
  "gate",
  "handoff",
]);
export type RunTrigger = z.infer<typeof RunTrigger>;

/** How a run ended: any run state except `running`. The `terminal` event carries it. */
export const RunOutcome = RunState.exclude(["running"]);
export type RunOutcome = z.infer<typeof RunOutcome>;
