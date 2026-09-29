import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type GitAuthor, type Result } from "@bayon/core";
import { INITIALISABLE, type FolderState } from "@bayon/proto";
import type { GitRunner } from "../../tickets/git-facts.js";
import { foreignRepoMessage, isGitRepo, isOwnRepo } from "../local-repo.js";

// What a folder is as a repo, and making a folder with no commit a repo with one. The
// caller has already held the real path to `projects.local_roots`. Git is the API's runGit: argv,
// SAFE_GIT, no global or system config — so no hook, no signing and no identity of the operator's.
//
// The first commit is **empty** and made with plumbing, never `git commit`: that would run hooks,
// commit whatever the index holds, and need an identity from a config we shut out. `commit-tree` of
// the empty tree adds none of the user's files; they stay untracked. `update-ref HEAD <sha> ""` sets
// HEAD's branch only if it still has no commit, so one made meanwhile is never overwritten.

const GIT_TIMEOUT_MS = 10_000;
const FIRST_MESSAGE = "Initial empty commit";
/** The branch a new repository starts on. */
export const INIT_BRANCH = "main";

export interface FolderFacts {
  readonly state: Exclude<FolderState, "not_allowed" | "missing">;
  /** The branch HEAD names; null when there is no repository. */
  readonly branch: string | null;
}

export interface FolderInitialised {
  readonly createdRepo: boolean;
  readonly branch: string;
  readonly commit: string;
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

async function headBranch(git: GitRunner, dir: string): Promise<string | null> {
  const run = await git(
    dir,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    GIT_TIMEOUT_MS,
    ceiling(dir),
  );
  return run.ok && run.stdout.trim() !== "" ? run.stdout.trim() : null;
}

/** Git kept from walking above `dir`: a broken `.git` must never reach a parent repository. */
const ceiling = (dir: string): Readonly<Record<string, string>> => ({
  GIT_CEILING_DIRECTORIES: dirname(dir),
});

/**
 * `dir`'s state as a repo. `dir` is a real path to an existing folder inside `root`, the allowed
 * folder (a real path): a repository that is not `dir`'s own, or whose git dir is outside `root`,
 * is `foreign_repo`.
 */
export async function folderState(
  git: GitRunner,
  dir: string,
  root: string,
): Promise<FolderFacts> {
  if (!(await isGitRepo(dir))) {
    const entries = await readdir(dir).catch(() => []);
    return {
      state: entries.length === 0 ? "not_repo_empty" : "not_repo_files",
      branch: null,
    };
  }
  if (!(await isOwnRepo(git, dir, root))) {
    return { state: "foreign_repo", branch: null };
  }
  const branch = await headBranch(git, dir);
  const head = await git(
    dir,
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    GIT_TIMEOUT_MS,
    ceiling(dir),
  );
  if (head.ok) return { state: "ready", branch };
  const heads = await git(
    dir,
    ["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads"],
    GIT_TIMEOUT_MS,
    ceiling(dir),
  );
  const anyBranch = heads.ok && heads.stdout.trim() !== "";
  return { state: anyBranch ? "unborn_head" : "no_commits", branch };
}

async function step(
  git: GitRunner,
  dir: string,
  args: readonly string[],
): Promise<Result<string>> {
  const run = await git(dir, args, GIT_TIMEOUT_MS, ceiling(dir));
  return run.ok
    ? ok(run.stdout.trim())
    : invalid(
        `Bayon could not set up git in ${dir} (${run.detail}). Check the folder's permissions, then try again.`,
      );
}

/**
 * A folder with no commit made a repo with one empty commit: `git init -b main` when there is no
 * repository, then the commit on HEAD's branch. Refused, touching nothing, when the folder has any
 * commit or its HEAD is unborn beside branches that have some.
 */
export async function initFolder(
  git: GitRunner,
  dir: string,
  root: string,
  author: GitAuthor,
): Promise<Result<FolderInitialised>> {
  const before = await folderState(git, dir, root);
  if (before.state === "foreign_repo") return invalid(foreignRepoMessage(dir));
  if (!INITIALISABLE.includes(before.state)) {
    return invalid(
      before.state === "ready"
        ? `${dir} already has commits, so Bayon leaves it as it is.`
        : `${dir} already has commits on other branches, so Bayon leaves it as it is. Switch to one of them there with git switch <branch>.`,
    );
  }
  const createdRepo = before.state !== "no_commits";
  if (createdRepo) {
    const init = await step(git, dir, ["init", "--quiet", "-b", INIT_BRANCH]);
    if (!init.ok) return init;
  }
  const branch = (await headBranch(git, dir)) ?? INIT_BRANCH;
  const tree = await step(git, dir, [
    "hash-object",
    "-t",
    "tree",
    "-w",
    "/dev/null",
  ]);
  if (!tree.ok) return tree;
  const commit = await step(git, dir, [
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    "commit-tree",
    "--no-gpg-sign",
    "-m",
    FIRST_MESSAGE,
    tree.value,
  ]);
  if (!commit.ok) return commit;
  const set = await step(git, dir, [
    "update-ref",
    "-m",
    FIRST_MESSAGE,
    "HEAD",
    commit.value,
    "",
  ]);
  if (!set.ok) return set;
  return ok({ createdRepo, branch, commit: commit.value });
}
