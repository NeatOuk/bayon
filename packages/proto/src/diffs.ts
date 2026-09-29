import { z } from "zod";
import { MCP_RESULT_CAP } from "./mcp-tools.js";

// GET /api/v1/sessions/:id/diff (§12.1, §12.4 #5): what a session changed, per repo. A
// local session's worktrees are diffed against their base on the API's host; a session on another
// executor, or a reviewer (its detached worktree has no row), shows its gate's diff.patch instead.
// The patch is capped like any tool result (§8.5, Invariant 9): its head within the cap, the whole
// text on disk, and that path in `full_path`.

const count = z.int().nonnegative();
const epochMs = z.int().nonnegative();

/** §8.5's cap, the one MCP results get: 8 KB / 200 lines. */
export const SESSION_DIFF_CAP = MCP_RESULT_CAP;

/** At most this many changed and untracked paths are listed per repo; the totals stay exact. */
export const SESSION_DIFF_MAX_FILES = 200;

/** The patch, capped: its first lines within SESSION_DIFF_CAP, and the size of the whole. */
export const CappedPatch = z.object({
  text: z.string(),
  truncated: z.boolean(),
  /** The whole patch's size. */
  bytes: count,
  lines: count,
  /** Where the whole patch is, on the API's host: set when truncated, null if it could not be kept. */
  full_path: z.string().nullable(),
});
export type CappedPatch = z.infer<typeof CappedPatch>;

/** One changed file, from the patch's own headers. Counts are null for a binary file. */
export const DiffFile = z.object({
  path: z.string(),
  added: count.nullable(),
  deleted: count.nullable(),
});
export type DiffFile = z.infer<typeof DiffFile>;

/** The gate whose diff.patch a repo's diff is. */
export const DiffGate = z.object({
  id: z.string(),
  kind: z.string(),
  attempt: z.int().positive(),
  state: z.string(),
});
export type DiffGate = z.infer<typeof DiffGate>;

export const RepoDiff = z.object({
  repo_id: z.string().nullable(),
  /** Set when diffed from a worktree; null for a gate's diff.patch. */
  worktree_id: z.string().nullable(),
  branch: z.string().nullable(),
  base_sha: z.string().nullable(),
  head_sha: z.string().nullable(),
  /** Set when this is a gate's diff.patch. */
  gate: DiffGate.nullable(),
  files: z.array(DiffFile),
  files_total: count,
  /** New files git does not track yet: not in the patch. */
  untracked: z.array(z.string()),
  untracked_total: count,
  patch: CappedPatch.nullable(),
  /** Why this repo has no patch to show; null when it has one. */
  unavailable: z.string().nullable(),
});
export type RepoDiff = z.infer<typeof RepoDiff>;

/** Where the diff came from: the session's worktrees, its gates' diff.patch, or nowhere. */
export const SessionDiffSource = z.enum(["worktree", "gate", "none"]);
export type SessionDiffSource = z.infer<typeof SessionDiffSource>;

export const SessionDiff = z.object({
  session_id: z.string(),
  source: SessionDiffSource,
  repos: z.array(RepoDiff),
  /** Source `none`: why there is nothing to show. */
  reason: z.string().nullable(),
  generated_at: epochMs,
});
export type SessionDiff = z.infer<typeof SessionDiff>;
