// A session's cwd and extra roots from its worktree rows: core's rootsOf
// over the rows a session still works in, with the workspace's roles. Spawn, successor and adopt
// all go through it, so none reads a row order to find the primary.
import { ok, rootsOf, type Result } from "@bayon/core";
import {
  getWorkspaceRepos,
  type Db,
  type SessionRow,
  type WorktreeRow,
} from "@bayon/db";

/** Rows no session works in any more. */
const DONE_WITH: readonly string[] = ["merged", "removed", "orphan"];

export interface SessionRoots {
  readonly cwd: string;
  readonly extraRoots?: readonly string[];
}

/**
 * The session's cwd and extra roots (absent when none): `session_root` without a live worktree.
 * A gate's reviewer (`gate_id`) works in its one worktree, whatever its repo's role.
 */
export async function sessionRoots(
  ctx: { readonly db: Db },
  s: Pick<SessionRow, "workspace_id" | "session_root" | "gate_id">,
  rows: readonly WorktreeRow[],
): Promise<Result<SessionRoots>> {
  const live = rows.filter((w) => !DONE_WITH.includes(w.state));
  const repos =
    s.workspace_id === null
      ? ok([])
      : await getWorkspaceRepos(ctx.db, s.workspace_id);
  if (!repos.ok) return repos;
  const roots = rootsOf(live, repos.value, { pinned: s.gate_id !== null });
  if (!roots.ok) return roots;
  if (roots.value === null) return ok({ cwd: s.session_root });
  const { cwd, extraRoots } = roots.value;
  return ok({ cwd, ...(extraRoots.length > 0 ? { extraRoots } : {}) });
}
