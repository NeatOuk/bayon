import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Logger } from "@nestjs/common";
import {
  LOCAL_ROOTS_KEY,
  LocalRoots,
  err,
  isInsideRoot,
  ok,
  type Result,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { z } from "zod";
import { runGit, type GitRunner } from "../tickets/git-facts.js";

// A folder as a project's repo (§14): accepted only inside one `projects.local_roots`
// allows, a shell-only control. Real paths on both sides, so a symlink inside an allowed folder
// that points out of it is refused, and the real path is what the repo row keeps.
// ponytail: checked at create time only. The mirror is cloned at the project's first spawn, which
// can be much later, and a folder swapped for a symlink by then is followed. Whoever can do that
// already writes to the operator's folders.
//
// A stored root is used only when it is its own real path: one that names a
// symlink could be re-pointed later to widen what agents reach, so it is skipped, with a warning
// saying to add it again by its real path. And a folder is its own repository only when git, kept
// from walking above it, finds the folder itself as the top level (or, bare, as the git dir) and a
// git dir inside the same allowed root: an empty or broken `.git`, a `.git` file or a `.git`
// symlink must never hand an agent — or `git init` — some other repository.

const log = new Logger("folders");
const GIT_TIMEOUT_MS = 10_000;

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** `value` as one shell word: single-quoted, with any `'` closed, escaped and reopened. */
const shellWord = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The shell command that allows `path`: `frm roots add` appends to the allowed folders
 * and finds the default home itself. `path` as typed, normalised: resolving it would tell a browser
 * elsewhere whether it exists.
 */
export const allowCommand = (path: string): string =>
  `pnpm frm roots add ${shellWord(resolve(path))} --yes`;

/** The refusal for a folder outside every allowed one, in plain words, with the one thing to do. */
export const notAllowedMessage = (path: string, command: string): string =>
  `Agents are not allowed to use ${JSON.stringify(path)} yet, or there is no folder there. ` +
  `To allow it, run this in a terminal on the machine Bayon runs on, in the Bayon folder: ${command}`;

/** fs/promises' realpath is the native one: on a case-insensitive disk (macOS) it also returns
 * the on-disk case, so a path typed in another case still compares equal. The JS realpathSync
 * would not — it keeps the case it was given, and refuses such a path. */
const realOrNull = (path: string): Promise<string | null> =>
  realpath(path).catch(() => null);

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A working tree (`.git` dir or file) or a bare repo (`HEAD` plus `objects`). */
export async function isGitRepo(dir: string): Promise<boolean> {
  if (await exists(join(dir, ".git"))) return true;
  return (
    (await exists(join(dir, "HEAD"))) && (await exists(join(dir, "objects")))
  );
}

/** Where a path stands against the allowed folders. */
export interface FolderPlace {
  /** The path's real path; null when nothing is there. */
  readonly real: string | null;
  /** The allowed folder it is inside (a real path); null when none. */
  readonly root: string | null;
  /** Its real path is inside one allowed folder. */
  readonly inside: boolean;
}

/** A stored root, when it is its own real path; any other is skipped with a warning. */
async function usableRoot(root: string): Promise<string | null> {
  const real = await realOrNull(root);
  if (real === root) return root;
  log.warn(
    real === null
      ? `An allowed folder, ${root}, no longer exists: it is skipped.`
      : `An allowed folder, ${root}, is a link to ${real}: it is skipped. Allow ${real} instead, by its real path.`,
  );
  return null;
}

/**
 * `path` against `projects.local_roots`, real paths on both sides (a symlink inside an allowed
 * folder that points out of it is outside). A stored list that does not parse is `validation`.
 */
export async function placeOf(
  db: Db,
  path: string,
): Promise<Result<FolderPlace>> {
  const rows = await getSettings(db, [LOCAL_ROOTS_KEY]);
  if (!rows.ok) return rows;
  const roots = LocalRoots.safeParse(rows.value.get(LOCAL_ROOTS_KEY) ?? []);
  if (!roots.success) {
    return invalid(
      `The list of folders agents may use is damaged (${z.prettifyError(roots.error)}). ` +
        `Set it again from a terminal: pnpm frm settings set ${LOCAL_ROOTS_KEY} <folders> --yes`,
    );
  }
  const real = await realOrNull(path);
  const usable = await Promise.all(roots.data.map(usableRoot));
  const root =
    real === null
      ? null
      : (usable.find((r): r is string => r !== null && isInsideRoot(real, r)) ??
        null);
  return ok({ real, root, inside: root !== null });
}

const ceilingEnv = (dir: string): Readonly<Record<string, string>> => ({
  GIT_CEILING_DIRECTORIES: dirname(dir),
});

async function gitLine(
  git: GitRunner,
  dir: string,
  args: readonly string[],
): Promise<string | null> {
  const run = await git(dir, args, GIT_TIMEOUT_MS, ceilingEnv(dir));
  return run.ok ? run.stdout.trim() : null;
}

/**
 * Whether the repository git finds at `dir` is `dir`'s own: git is kept from walking above it, its
 * top level (or, bare, its git dir) is `dir` itself, and its git dir is inside `root`. `dir` and
 * `root` are real paths.
 */
export async function isOwnRepo(
  git: GitRunner,
  dir: string,
  root: string,
): Promise<boolean> {
  const gitDir = await gitLine(git, dir, ["rev-parse", "--absolute-git-dir"]);
  const realGitDir = gitDir === null ? null : await realOrNull(gitDir);
  if (realGitDir === null || !isInsideRoot(realGitDir, root)) return false;
  const bare = await gitLine(git, dir, ["rev-parse", "--is-bare-repository"]);
  if (bare === "true") return realGitDir === dir;
  const top = await gitLine(git, dir, ["rev-parse", "--show-toplevel"]);
  return top !== null && (await realOrNull(top)) === dir;
}

/** The refusal for a folder whose `.git` leads to another repository. */
export const foreignRepoMessage = (path: string): string =>
  `${JSON.stringify(path)} has a .git that belongs to another repository, or is broken. ` +
  `Bayon leaves it alone: fix or remove that .git there, then try again.`;

/**
 * `path`'s real path, when it is a git repo inside a folder the operator allowed; otherwise why
 * not (`validation`). A missing path and one outside every allowed folder get the same answer, so
 * the route is no oracle for what exists elsewhere on the host.
 */
export async function allowedLocalRepo(
  db: Db,
  path: string,
  git: GitRunner = runGit(),
): Promise<Result<string>> {
  const place = await placeOf(db, path);
  if (!place.ok) return place;
  const { real, root } = place.value;
  if (root === null || real === null) {
    return invalid(notAllowedMessage(path, allowCommand(path)));
  }
  if (!(await isGitRepo(real))) {
    return invalid(
      `${JSON.stringify(path)} is not a git repository yet. ` +
        `Use "Initialise this folder as a git repository" in the New project form, or run git init there and make a first commit.`,
    );
  }
  if (!(await isOwnRepo(git, real, root))) {
    return invalid(foreignRepoMessage(path));
  }
  return ok(real);
}
