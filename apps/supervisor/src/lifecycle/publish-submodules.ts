// Publishing a builder's submodule commits. A commit made
// inside a submodule lands in the superproject worktree's module gitdir
// (<mirror>/worktrees/<worktree>/modules/<name>) and nowhere else: the child repo's own mirror never
// sees it, so a gitlink bump is refused by the H1 check (gates/subject.ts) and the sweep cannot read
// the commit as merged. This fetches the session's own branch out of each module gitdir into its
// child's mirror — one child mutex at a time and none held around it, §3.3's rule — and answers with
// the HEADs it published, which the hand-off facts carry (Q7).
//
// Two things here are agent-writable and so are never trusted:
//
//  - The gitdir a submodule directory resolves to. Git's discovery walks **up**, so a submodule that
//    holds no repository (deinit'd, its `.git` removed, or a commit predating the gitlink checked
//    out) answers with the *superproject's* gitdir — and `--absolute-git-dir` follows a `.git`
//    *file*, which an agent can write to name any repository on this host. Either way the fetch
//    source would be a repository that is not this child's, and its HEAD would be published into the
//    child's mirror under the session's branch and reported as the submodule's head. So the gitdir
//    is computed from the superproject's (module-gitdir.ts) and the resolved one must equal it.
//  - The refspec. `frm/*` forced would let a session that ran `git branch frm/<other sid>` rewrite
//    another session's published branch; only `frm/<this session>` is this session's to own.
import { posix } from "node:path";
import { ok, type Result } from "@bayon/core";
import type { Db } from "@bayon/db";
import type { Executor } from "@bayon/executors";
import type { ExecCtx } from "./exec.js";
import { mirrorKey } from "./mirror.js";
import { moduleGitDirs } from "./module-gitdir.js";
import type { KeyedQueue } from "./session-queue.js";
import { git } from "./workspace.js";
import { loadLayout } from "./workspace-plan.js";

/** One submodule's HEAD, once its commits are in its mirror. */
export interface PublishedHead {
  /** From the superproject's root, as workspace_repos.submodule_path spells it. */
  readonly path: string;
  readonly repo_id: string;
  readonly sha: string;
}

export interface PublishDeps {
  readonly db: Db;
  readonly exec: ExecCtx;
  readonly executor: Executor;
  /** Keyed by mirror path: the child's mutex. */
  readonly mirrors: KeyedQueue;
}

/** The worktree to publish out of: a superproject's, or this does nothing. */
export interface SuperWorktree {
  readonly path: string;
  readonly workspace_id: string;
  readonly repo_id: string;
  /** `frm/<session id>` while a session owns it; `detached@<sha>` for a reviewer's (workspace.ts).
   * The one branch this worktree's submodules are on, and the only one it may publish. */
  readonly branch: string;
}

/** A session's own branch, forced — the session owns that one ref and no other. */
const own = (branch: string): string =>
  `+refs/heads/${branch}:refs/heads/${branch}`;

/** Only a session's branch is publishable: a detached checkout committed on no branch of its own. */
const publishable = (branch: string): boolean =>
  branch.startsWith("frm/") &&
  !branch.includes("..") &&
  !/[~^:?*[\\\s]/.test(branch);

/**
 * Every submodule of `wt`'s workspace, published into its own mirror, and its HEAD. Nothing to do
 * for any worktree but a submodule workspace's superproject. A submodule that holds no repository
 * (never populated, or removed at this commit), one whose gitdir is not the one git would give it,
 * and one with no branch of this session's to publish are each passed over with a logged reason:
 * the caller's own check still judges the gitlink. A fetch that fails is the error — a gate that
 * pinned past it would review a commit its reviewer cannot read.
 */
export async function publishSubmodules(
  d: PublishDeps,
  wt: SuperWorktree,
  signal?: AbortSignal,
): Promise<Result<readonly PublishedHead[]>> {
  // A container's worktree is not on this host and its mirrors are the executor's own: publishing
  // back across the link is M4's sync-back, not this.
  if (d.executor.placeSession !== undefined) return ok([]);
  const layout = await loadLayout(d.db, wt.workspace_id);
  if (!layout.ok) return layout;
  const { kind, primary, submodules } = layout.value;
  if (kind !== "submodule" || wt.repo_id !== primary.id) return ok([]);
  const skip = (path: string, why: string): void => {
    d.exec.log.warn(
      { worktree: wt.path, submodule: path, reason: why },
      `not publishing the submodule ${path}: ${why}`,
    );
  };
  if (!publishable(wt.branch)) {
    skip(
      "",
      `worktree ${wt.path} is on ${wt.branch}, not a session's frm/ branch`,
    );
    return ok([]);
  }
  // What git gives each submodule, from the superproject's own gitdir: never from discovery in the
  // submodule directory, which walks up and follows an agent-written `.git` file.
  const superGitDir = await git(
    d.exec,
    d.executor,
    wt.path,
    ["rev-parse", "--absolute-git-dir"],
    signal,
  );
  if (!superGitDir.ok) return superGitDir;
  const expected = moduleGitDirs(
    superGitDir.value,
    submodules.map((s) => s.submodule_path ?? ""),
  );
  const published: PublishedHead[] = [];
  for (const repo of submodules) {
    const path = repo.submodule_path ?? "";
    if (path === "") continue;
    const want = expected.get(path);
    if (want === undefined) {
      skip(path, "its declared path is not a path inside the superproject");
      continue;
    }
    const dir = posix.join(wt.path, path);
    const gitDir = await git(
      d.exec,
      d.executor,
      dir,
      ["rev-parse", "--absolute-git-dir"],
      signal,
    );
    if (!gitDir.ok) continue;
    if (gitDir.value !== want) {
      skip(
        path,
        `it resolves to ${gitDir.value}, not its own module gitdir ${want}`,
      );
      continue;
    }
    // The branch must be in that module gitdir: a detached submodule, or one whose branch the agent
    // deleted, has nothing of this session's to publish, and naming a missing source is a hard error
    // where `frm/*` used to be a quiet no-op.
    const branch = await git(
      d.exec,
      d.executor,
      dir,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}^{commit}`],
      signal,
    );
    if (!branch.ok) {
      skip(path, `it is not on ${wt.branch}`);
      continue;
    }
    const head = await git(
      d.exec,
      d.executor,
      dir,
      ["rev-parse", "HEAD"],
      signal,
    );
    if (!head.ok) continue;
    const fetched = await d.mirrors.run(mirrorKey(repo.mirror_path), () =>
      git(
        d.exec,
        d.executor,
        repo.mirror_path,
        ["fetch", "--no-tags", want, own(wt.branch)],
        signal,
      ),
    );
    if (!fetched.ok) return fetched;
    published.push({ path, repo_id: repo.id, sha: head.value });
  }
  return ok(published);
}
