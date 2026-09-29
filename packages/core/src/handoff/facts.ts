import { z } from "zod";

// The generated half of a hand-off packet (§7.2): built from git, events and counters by the
// supervisor, never from model output. Stored as `handoffs.facts_json`.

const text = z.string().min(1);
const count = z.int().nonnegative();

/** One changed path: its porcelain code (`M`, `A`, `??`, …), or `committed` if clean now. */
export const HandoffFile = z.object({
  path: text,
  code: text,
  added: count.optional(),
  removed: count.optional(),
});
export type HandoffFile = z.infer<typeof HandoffFile>;

/** One worktree of the session, per repo (M4 brings more than one). */
export const RepoFacts = z.object({
  repo_id: text,
  branch: text,
  base_sha: text,
  head_sha: text.nullable(),
  commits: count,
  files: z.array(HandoffFile),
  /**
   * A submodule workspace's superproject (): each submodule's HEAD at hand-off, already
   * published to its own mirror, so a successor's gitlink is a commit it can reach.
   * Absent on every other worktree, and when the publish itself failed.
   */
  submodules: z
    .array(z.object({ path: text, repo_id: text, sha: text }))
    .optional(),
  /** Why git gave no answer: the list is then empty and says so. */
  git_error: z.string().optional(),
});
export type RepoFacts = z.infer<typeof RepoFacts>;

/** A canonical `command` event: what ran and how it ended. */
export const CommandFact = z.object({
  argv: z.array(z.string()).min(1),
  exit_code: z.int().nullable(),
  status: z.string().nullable(),
});
export type CommandFact = z.infer<typeof CommandFact>;

export const HandoffFacts = z.object({
  v: z.literal(1),
  ticket: z.object({ id: text, key: text, status: text }),
  session: z.object({ id: text, role: text, run_class: text }),
  repos: z.array(RepoFacts),
  /** Why no repo could be read at all, e.g. the executor is not loaded. */
  git_error: z.string().optional(),
  commands: z.array(CommandFact),
  gates: z.array(z.object({ kind: text, state: text, attempt: count })),
  findings_open: count,
  questions: z.array(z.object({ id: text, text: z.string() })),
  spend: z.object({
    session_usd: z.number().nonnegative(),
    ticket_usd: z.number().nonnegative(),
  }),
  counters: z.object({
    turns: count,
    max_turns: count,
    tool_calls: count,
    context_peak_tokens: count.nullable(),
    context_cap: count,
  }),
  events: z.object({ first_id: count.nullable(), last_id: count.nullable() }),
  gathered_at: count,
  /**
   * What a degraded packet says of its missing or unverified judgement ("the session died").
   * Stored so the row re-renders to its packet_hash when a successor spawns (M2-c).
   */
  why: z.string().optional(),
});
export type HandoffFacts = z.infer<typeof HandoffFacts>;
