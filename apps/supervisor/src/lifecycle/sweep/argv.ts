// The sweep's git argv: one builder for every status call and for
// `worktree remove`. The -c pairs outrank every config file an agent can write, the shared mirror's
// config and config.worktree included, and reach git's own status inside `worktree remove` and its
// submodule children through GIT_CONFIG_PARAMETERS (g12).

/** Outranks status.showUntrackedFiles=no and a stale untracked cache (C1a). */
export const STATUS_PAIRS: readonly string[] = [
  "-c",
  "status.showUntrackedFiles=all",
  "-c",
  "core.untrackedCache=false",
];

/** On every sweep git call: a promisor remote is never asked for a missing object (L3). */
export const SWEEP_ENV: Readonly<Record<string, string>> = {
  GIT_NO_LAZY_FETCH: "1",
};

/** Check 8: changes and untracked files, every one listed (C1a), submodules never ignored. */
export const changesArgs = (dir: string): string[] => [
  "-C",
  dir,
  ...STATUS_PAIRS,
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--ignore-submodules=none",
];

/**
 * Check 9: the ignored inventory. `matching` lists each path that matches an ignore pattern, and a
 * matching directory once; `traditional` collapses a directory whose contents are all ignored into
 * the directory itself (`sub/` for `sub/node_modules/`), which no disposable name can match (g20).
 * Every ignored path is listed, or lies under a listed directory that matched. --untracked-files
 * =normal keeps a matching directory's contents out (g14).
 */
export const ignoredArgs = (dir: string): string[] => [
  "-C",
  dir,
  ...STATUS_PAIRS,
  "status",
  "--porcelain=v1",
  "-z",
  "--ignored=matching",
  "--untracked-files=normal",
  "--ignore-submodules=none",
];

/** The only `worktree remove` argv (§6 B16): never --force. `path` is absolute, never a flag. */
export const worktreeRemoveArgs = (mirror: string, path: string): string[] => [
  "-C",
  mirror,
  ...STATUS_PAIRS,
  "worktree",
  "remove",
  path,
];

/** Tokens no sweep argv ever carries (§10); the tests check every argv against them. */
export const FORBIDDEN_TOKENS: readonly string[] = [
  "--force",
  "-f",
  "deinit",
  "prune",
  "unlock",
  "clean",
];
