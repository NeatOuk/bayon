import { err, ok, type Result } from "../errors.js";

// Which worktree is a session's cwd and which are its extra roots: the one
// helper spawn, successor and adopt share, so none of them reads an order to find the primary.

/** A worktree row the session runs in. */
export interface RootRow {
  readonly id: string;
  readonly repo_id: string;
  readonly path: string;
}

/** A workspace_repos row: its repo id, role and path under the session root. */
export interface RootRepo {
  readonly id: string;
  readonly role: string;
  readonly rel_path: string;
}

export interface Roots {
  readonly cwd: string;
  /** Sorted by the repos' rel_path. */
  readonly extraRoots: readonly string[];
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/**
 * The session's roots, or null without a worktree. A builder's cwd is the primary repo's worktree
 * (`role='primary'`, or a one-repo workspace's repo) and its other worktrees are extra roots; a set
 * without the primary is refused. A pinned checkout (a gate's reviewer) works in exactly one
 * worktree, whatever its repo's role, with no extra roots.
 */
export function rootsOf(
  rows: readonly RootRow[],
  repos: readonly RootRepo[],
  o: { readonly pinned: boolean },
): Result<Roots | null> {
  const [first] = rows;
  if (first === undefined) return ok(null);
  if (o.pinned) {
    return rows.length === 1
      ? ok({ cwd: first.path, extraRoots: [] })
      : invalid(
          `a pinned checkout works in exactly one worktree, not ${rows.length}`,
        );
  }
  const ids = new Set(rows.map((r) => r.repo_id));
  if (ids.size !== rows.length) {
    return invalid("the session holds two worktrees of one repo");
  }
  const primaryId =
    repos.find((r) => r.role === "primary")?.id ??
    (repos.length === 1 ? repos[0]?.id : undefined) ??
    (rows.length === 1 ? first.repo_id : undefined);
  const primary = rows.find((r) => r.repo_id === primaryId);
  if (primary === undefined) {
    return invalid(
      `the session's worktrees lack the workspace's primary repo ${primaryId ?? "(none declared)"}`,
    );
  }
  const relOf = (row: RootRow): string =>
    repos.find((r) => r.id === row.repo_id)?.rel_path ?? row.path;
  const extraRoots = rows
    .filter((r) => r !== primary)
    .toSorted((a, b) => (relOf(a) < relOf(b) ? -1 : 1))
    .map((r) => r.path);
  return ok({ cwd: primary.path, extraRoots });
}
