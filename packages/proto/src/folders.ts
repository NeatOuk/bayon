import { z } from "zod";

// A folder as a project's repo, checked before it is created: what the
// folder is, whether this browser is on the Bayon host itself, and the two actions the New project
// form may offer — allow the folder (host only, appends to `projects.local_roots`), and make an
// empty folder or a repo with no commits a repo with one empty commit.

/**
 * Set by the web proxy on a request it forwards from a browser on this host, after removing any
 * copy the browser sent. Its value is the host-only key in `$FRM_HOME/local-browser.key`; the API
 * honours it only on a loopback socket (§14 amendment). The dev proxy keeps its own copy of the name
 * (apps/web/server/local-browser.ts; a test holds them equal).
 */
export const LOCAL_BROWSER_HEADER = "x-frm-local-browser";

const FolderPath = z.string().min(1).max(4_096);

export const FolderCheckRequest = z.strictObject({ path: FolderPath });
export type FolderCheckRequest = z.infer<typeof FolderCheckRequest>;

export const FolderInitRequest = FolderCheckRequest;
export type FolderInitRequest = FolderCheckRequest;

/** `folder` (the default) adds the folder itself; `parent` the folder that holds it. */
export const FolderAllowScope = z.enum(["folder", "parent"]);
export type FolderAllowScope = z.infer<typeof FolderAllowScope>;

export const FolderAllowRequest = z.strictObject({
  path: FolderPath,
  scope: FolderAllowScope.default("folder"),
  /** The real path the confirm showed: refused unless it is still the folder that would be added. */
  expect_root: FolderPath,
});
export type FolderAllowRequest = z.infer<typeof FolderAllowRequest>;

/**
 * - `not_allowed`: not inside an allowed folder — or, to a browser elsewhere, not there at all (the
 *   route is no oracle for what exists on the host);
 * - `missing`: no folder there (told only to a browser on the host);
 * - `not_repo_empty` | `not_repo_files`: no git repository in the folder itself;
 * - `no_commits`: a repository without a single commit;
 * - `unborn_head`: its HEAD names a branch with no commits, while other branches have some;
 * - `foreign_repo`: its `.git` is broken, or leads to a repository that is not the folder's own or
 *   lies outside the allowed folder; nothing acts on it;
 * - `ready`: a repository with a commit on HEAD.
 */
export const FolderState = z.enum([
  "not_allowed",
  "missing",
  "not_repo_empty",
  "not_repo_files",
  "no_commits",
  "unborn_head",
  "foreign_repo",
  "ready",
]);
export type FolderState = z.infer<typeof FolderState>;

/** The states `POST /folders/init` may act on: nothing with a commit is ever touched. */
export const INITIALISABLE: readonly FolderState[] = [
  "not_repo_empty",
  "not_repo_files",
  "no_commits",
];

export const FolderCheck = z.object({
  path: z.string(),
  state: FolderState,
  /** The request came from a browser on the Bayon host itself. */
  local: z.boolean(),
  /** The folder's real path, when it is inside an allowed folder, or local and there. */
  real_path: z.string().nullable(),
  /** The parent `scope: parent` would allow; null when that is refused or not offered. */
  parent: z.string().nullable(),
  /** The branch HEAD names, for `unborn_head`. */
  branch: z.string().nullable(),
  /** The shell command that allows this folder, for a browser elsewhere. */
  allow_command: z.string(),
});
export type FolderCheck = z.infer<typeof FolderCheck>;

export const FolderAllowed = z.object({
  /** The folder added (a real path). */
  root: z.string(),
  roots: z.array(z.string()),
  /** False when an allowed folder already covered it. */
  changed: z.boolean(),
});
export type FolderAllowed = z.infer<typeof FolderAllowed>;
