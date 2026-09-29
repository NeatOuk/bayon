// Where git keeps a submodule's own repository. A populated submodule of a linked
// worktree has no repository in the working tree at all: its `.git` is a file pointing at the module
// gitdir the superproject owns, `<super gitdir>/modules/<path under the superproject>`, and a nested
// submodule nests the same way under *its* parent's module gitdir (verified on git 2.50).
//
// This matters because git's repository discovery walks **up**. Asking an unpopulated submodule
// directory for `rev-parse --absolute-git-dir` answers with the *superproject's* gitdir, and a `.git`
// file is ordinary agent-writable content that can name any repository on the host. So a gitdir is
// never taken from discovery alone: it is computed here from the superproject's and compared.
import { posix } from "node:path";

/** A path is relative, non-empty and has no `.`, `..` or empty segment — as a gitlink's must be. */
function insideSuper(path: string): boolean {
  if (path === "" || posix.isAbsolute(path)) return false;
  const parts = path.split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

/** The declared path this one nests under: the longest that is a proper parent of it, or null. */
function parentOf(path: string, declared: readonly string[]): string | null {
  let best: string | null = null;
  for (const other of declared) {
    if (other === path || !path.startsWith(`${other}/`)) continue;
    if (best === null || other.length > best.length) best = other;
  }
  return best;
}

/**
 * The gitdir git gives each declared submodule of a worktree whose own gitdir is `superGitDir`,
 * keyed by the submodule's path from the superproject's root (`workspace_repos.submodule_path`).
 *
 * `superGitDir` must be what git itself answered (`rev-parse --absolute-git-dir`), so the result is
 * canonical the way the child's own answer will be. A path that is not a path inside the
 * superproject is left out of the map: a caller with nothing to compare against must skip, never
 * guess.
 */
export function moduleGitDirs(
  superGitDir: string,
  paths: readonly string[],
): ReadonlyMap<string, string> {
  const declared = [...new Set(paths.filter(insideSuper))];
  // Parents before children: a child's gitdir is built from its parent's, never from the root's.
  const byDepth = declared.toSorted((a, b) => a.length - b.length);
  const dirs = new Map<string, string>();
  for (const path of byDepth) {
    const parent = parentOf(path, declared);
    const base = parent === null ? superGitDir : dirs.get(parent);
    if (base === undefined) continue;
    const rel = parent === null ? path : path.slice(parent.length + 1);
    dirs.set(path, `${base}/modules/${rel}`);
  }
  return dirs;
}
