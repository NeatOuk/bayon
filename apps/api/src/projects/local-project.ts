import { join } from "node:path";
import {
  err,
  ok,
  parseGitlinks,
  parseGitmodules,
  type FoundSubmodule,
  type Result,
} from "@bayon/core";
import type { Db } from "@bayon/db";
import { runGit, type GitRunner } from "../tickets/git-facts.js";
import { allowedLocalRepo } from "./local-repo.js";

// A folder as a whole project (§3.1): the folder, and when its committed HEAD has a
// .gitmodules, every submodule checked out in it — each held to the same allowed-folder check as
// the folder itself, so a submodule whose folder is a symlink out of the allowed ones is refused.
// Read the way the supervisor will read it at spawn (workspace-plan.ts): the committed .gitmodules
// and gitlinks, not the working copy's.
// ponytail: one level. A submodule with submodules of its own is refused; the layout supports
// nesting, so this is where to recurse when an operator needs it.

const GIT_TIMEOUT_MS = 10_000;

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

export interface LocalProject {
  /** The folder's real path. */
  readonly origin: string;
  /** A branch it has (`baseOf`); null when none, which the door refuses unless one is asked for. */
  readonly base: string | null;
  readonly submodules: readonly FoundSubmodule[];
}

async function branchOf(git: GitRunner, dir: string): Promise<string | null> {
  const run = await git(
    dir,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    GIT_TIMEOUT_MS,
  );
  return run.ok && run.stdout.trim() !== "" ? run.stdout.trim() : null;
}

const hasBranch = async (
  git: GitRunner,
  dir: string,
  name: string,
): Promise<boolean> =>
  (
    await git(
      dir,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
      GIT_TIMEOUT_MS,
    )
  ).ok;

/**
 * A base branch the folder really has — the supervisor fetches `refs/heads/<base>` from it at every
 * spawn, so the column's `main` default would fail on a folder without one. The branch it is on;
 * detached (a submodule checked out by `git submodule update`), its `main` or `master`, else the
 * first of `fallbacks` (branches holding the pinned commit); null when none.
 */
async function baseOf(
  git: GitRunner,
  dir: string,
  fallbacks: readonly string[] = [],
): Promise<string | null> {
  const on = await branchOf(git, dir);
  if (on !== null) return on;
  for (const name of ["main", "master"]) {
    if (await hasBranch(git, dir, name)) return name;
  }
  return fallbacks[0] ?? null;
}

/** Whether HEAD's tree has a .gitmodules; git failing to read HEAD at all is `validation`. */
async function declaresSubmodules(
  git: GitRunner,
  dir: string,
): Promise<Result<boolean>> {
  const run = await git(
    dir,
    ["ls-tree", "-z", "HEAD", "--", ".gitmodules"],
    GIT_TIMEOUT_MS,
  );
  return run.ok
    ? ok(run.stdout !== "")
    : invalid(
        `${JSON.stringify(dir)} has no commit on its current branch yet. ` +
          `Make a first commit there, or switch to a branch that has one, then try again.`,
      );
}

async function submoduleOf(
  db: Db,
  git: GitRunner,
  root: string,
  path: string,
): Promise<Result<FoundSubmodule>> {
  const dir = await allowedLocalRepo(db, join(root, path), git);
  if (!dir.ok) {
    return invalid(
      `submodule ${path}: ${dir.error.message}. It must be checked out in the folder (git submodule update --init)`,
    );
  }
  const nested = await declaresSubmodules(git, dir.value);
  if (!nested.ok) return invalid(`submodule ${path}: ${nested.error.message}`);
  if (nested.value) {
    return invalid(
      `submodule ${path} has submodules of its own: a nested one is not set up from here yet`,
    );
  }
  // The dep's mirror is a bare clone of this folder, which carries its branches and tags only:
  // the commit the folder pins must be on one, or the first checkout cannot find it.
  const tree = await git(
    root,
    ["ls-tree", "-z", "HEAD", "--", path],
    GIT_TIMEOUT_MS,
  );
  const pinned = tree.ok ? parseGitlinks(tree.stdout).get(path) : undefined;
  if (pinned === undefined) {
    return invalid(
      `submodule ${path} is in .gitmodules but HEAD pins no commit for it`,
    );
  }
  const holders = await git(
    dir.value,
    [
      "for-each-ref",
      `--contains=${pinned}`,
      "--format=%(refname)",
      "refs/heads",
      "refs/tags",
    ],
    GIT_TIMEOUT_MS,
  );
  const refs = holders.ok ? holders.stdout.split("\n").filter(Boolean) : [];
  if (refs.length === 0) {
    return invalid(
      `submodule ${path}: the commit the folder pins (${pinned.slice(0, 12)}) is on no branch or tag in ${dir.value}`,
    );
  }
  const heads = refs
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length));
  const base = await baseOf(git, dir.value, heads);
  if (base === null) {
    return invalid(
      `submodule ${path} is on no branch and has none to use as its base: check a branch out in ${dir.value}`,
    );
  }
  return ok({ path, origin: dir.value, base });
}

/** `path` as a project: its real path, its branch and its submodules, or why not (`validation`). */
export async function localProject(
  db: Db,
  path: string,
  git: GitRunner = runGit(),
): Promise<Result<LocalProject>> {
  const origin = await allowedLocalRepo(db, path, git);
  if (!origin.ok) return origin;
  const root = origin.value;
  const base = await baseOf(git, root);
  const declared = await declaresSubmodules(git, root);
  if (!declared.ok) return declared;
  if (!declared.value) return ok({ origin: root, base, submodules: [] });

  const listed = await git(
    root,
    [
      "config",
      // An `[include] path=` in the blob would read any file on the host, before any folder check
      // runs: shut out, as workspace-plan.ts does for the same read.
      "--no-includes",
      "--blob",
      "HEAD:.gitmodules",
      "--null",
      "--get-regexp",
      "^submodule\\.",
    ],
    GIT_TIMEOUT_MS,
  );
  if (!listed.ok) {
    return invalid(`${path}: its .gitmodules cannot be read: ${listed.detail}`);
  }
  const entries = parseGitmodules(listed.stdout);
  if (!entries.ok) return entries;
  const submodules: FoundSubmodule[] = [];
  for (const entry of entries.value) {
    const found = await submoduleOf(db, git, root, entry.path);
    if (!found.ok) return found;
    submodules.push(found.value);
  }
  return ok({ origin: root, base, submodules });
}
