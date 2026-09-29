import { z } from "zod";

/** The §5.1 capability matrix: declared in `runners.caps_json`, verified by conformance (§15). */
export const RunnerCaps = z.object({
  structuredEvents: z.boolean(),
  multiTurnInProcess: z.boolean(),
  resumable: z.boolean(),
  /**
   * Two of this runner's sessions may be live at once — its credential can serve more than one.
   * Absent, admission admits one session for this runner at a time and queues the rest, the way a
   * budget cap or a fleet pause queues a spawn: a single-session credential is a capacity limit,
   * never a spawn error. A runner whose answer depends on which credential a session resolved
   * declares the narrower value unless the wider one is certain (§5.1).
   */
  concurrentSessions: z.boolean(),
  costReporting: z.boolean(),
  tokenCounting: z.boolean(),
  toolApprovalCallback: z.boolean(),
  sandboxModes: z.boolean(),
  mcpClient: z.boolean(),
  hooks: z.boolean(),
  pty: z.boolean(),
  outputSchema: z.boolean(),
  imageInput: z.boolean(),
  subagents: z.boolean(),
});
export type RunnerCaps = z.infer<typeof RunnerCaps>;
