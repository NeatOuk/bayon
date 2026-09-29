// A repo's mirror on first use (§9.2; M4 amendment: mirrors are created on first use, one per
// executor). This is the supervisor's own mirror at repos.mirror_path: the local executor's
// worktrees come off it, and a container's mirror is pushed from it. The caller holds
// the per-mirror mutex (ctx.mirrors, keyed by mirrorKey), so concurrent first spawns of a repo make
// exactly one clone. `git clone --bare` runs into a fresh directory beside the mirror, which is
// renamed into place only once the clone succeeded: a failed, stopped or timed-out clone never
// leaves a directory at mirror_path that a later spawn would trust.
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { err, ok, redactedConfigKey, type Result } from "@bayon/core";
import type { RepoRow } from "@bayon/db";
import { NO_GIT_AUTH, type GitAuth } from "../forge/credential.js";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";
import { failedGit, hostGitRun } from "./host-git.js";
import { hardenMirrorConfig } from "./mirror-config.js";

/** What first use needs of the lifecycle: the git deadline, its clock, PATH and log. */
export type MirrorCtx = Pick<Ctx, "settings" | "clock" | "path" | "log">;
export type MirrorRepo = Pick<RepoRow, "id" | "origin_url" | "mirror_path">;

/** The mirror was there already, or this call cloned it. */
export type MirrorUse = "present" | "cloned";

/** git's remote helpers that run a program named in the URL itself: never a repo's origin. */
const PROGRAM_TRANSPORT = /^(?:ext|fd)::/i;

/** The per-mirror mutex's key (L2): one queue per mirror however its path is spelled. */
export const mirrorKey = (mirrorPath: string): string =>
  posix.normalize(mirrorPath);

/** Why `path` cannot be a mirror_path, or null. */
export function mirrorPathProblem(path: string): string | null {
  if (path.startsWith("-")) return "starts with '-'";
  if (!isAbsolute(path)) return "is not an absolute path";
  return null;
}

/** Why `url` cannot be cloned from, or null. argv carries it, never a shell. */
export function originUrlProblem(url: string): string | null {
  if (url.trim() === "") return "is empty";
  if (url.startsWith("-")) return "starts with '-'";
  if (PROGRAM_TRANSPORT.test(url)) return "names a program transport";
  return null;
}

/**
 * The repo's mirror, cloned from its origin_url when mirror_path does not exist yet. Call it
 * under ctx.mirrors for `mirrorKey(repo.mirror_path)`. A refused row is `validation`; a failed
 * clone is `spawn_failed`, a stop `interrupted`, workspace.git_timeout_ms `timeout`.
 *
 * Either way the mirror leaves here with the hardened repo-local config (mirror-
 * config.ts): a config that cannot be read or written fails the call rather than handing back a
 * mirror whose own config could run a command on the next checkout.
 */
export async function ensureMirror(
  ctx: MirrorCtx,
  repo: MirrorRepo,
  signal: AbortSignal,
  /** The origin's forge token for the first clone, if any (`originGitAuth`). */
  auth: GitAuth = NO_GIT_AUTH,
): Promise<Result<MirrorUse>> {
  const mirror = repo.mirror_path;
  const badPath = mirrorPathProblem(mirror);
  if (badPath !== null) {
    return refused(repo, `mirror_path ${JSON.stringify(mirror)} ${badPath}`);
  }
  const found = await isDirectory(repo, mirror);
  if (!found.ok) return found;
  // A mirror already on disk is brought up to the hardened config too: that is the
  // whole migration pass, and it is idempotent, so the second use of a mirror writes nothing.
  if (found.value) {
    const hardened = await harden(ctx, repo, mirror, signal);
    return hardened.ok ? ok("present") : hardened;
  }
  const url = repo.origin_url;
  if (url === null) {
    return refused(
      repo,
      `has no mirror at ${mirror} and no origin_url to clone it from`,
    );
  }
  const badUrl = originUrlProblem(url);
  if (badUrl !== null) {
    return refused(repo, `origin_url ${JSON.stringify(url)} ${badUrl}`);
  }
  return cloneInPlace(ctx, repo, url, mirror, signal, auth);
}

const refused = (repo: MirrorRepo, why: string): Result<never> =>
  err(frmError("validation", `repo ${repo.id}: ${why}`));

/**
 * The hardened repo-local config on `mirror`, and a line for whatever it had to change
 * — a mirror that needed one is a fact worth a log entry, and a hardened one is silent.
 *
 * The logged keys are redacted to `section.*.key`: a value is never logged, but for
 * `url.<base>.insteadOf` the base *is* the key, and a base is commonly spelled
 * `https://x-access-token:<token>@github.com/` — a credential in a log line (Invariant 11).
 */
async function harden(
  ctx: MirrorCtx,
  repo: MirrorRepo,
  dir: string,
  signal: AbortSignal,
  /** What to call it in the log: a fresh clone is hardened before it is moved into place. */
  named = dir,
): Promise<Result<void>> {
  const changed = await hardenMirrorConfig(
    ctx,
    dir,
    { originUrl: repo.origin_url },
    signal,
  );
  if (!changed.ok) return changed;
  if (changed.value.length > 0) {
    ctx.log.info(
      {
        repo: repo.id,
        mirror: named,
        changes: changed.value.map((c) => redactedConfigKey(c.key)),
      },
      "mirror config hardened",
    );
  }
  return ok(undefined);
}

/** Whether a directory is at `path`: absent is false, anything else there is an error. */
async function isDirectory(
  repo: MirrorRepo,
  path: string,
): Promise<Result<boolean>> {
  try {
    if ((await stat(path)).isDirectory()) return ok(true);
    return refused(repo, `mirror_path ${path} is not a directory`);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      return ok(false);
    }
    return err(
      frmError("internal", `repo ${repo.id}: cannot stat ${path}`, String(e)),
    );
  }
}

/** Clones into a fresh sibling of `mirror`, then renames it into place; on failure removes it. */
async function cloneInPlace(
  ctx: MirrorCtx,
  repo: MirrorRepo,
  url: string,
  mirror: string,
  signal: AbortSignal,
  auth: GitAuth,
): Promise<Result<MirrorUse>> {
  const repoId = repo.id;
  const what = `git clone --bare of repo ${repoId}`;
  const parent = dirname(mirror);
  let tmp: string;
  try {
    await mkdir(parent, { recursive: true });
    tmp = await mkdtemp(join(parent, `.${basename(mirror)}.clone-`));
  } catch (e) {
    return err(
      frmError(
        "spawn_failed",
        `${what}: cannot make a directory beside ${mirror}`,
        String(e),
      ),
    );
  }
  const cloned = await gitClone(ctx, what, url, tmp, signal, auth);
  // Hardened where it was cloned, before the rename: a *freshly cloned* mirror is never
  // at mirror_path with a config that has not been through the pass. That is all this ordering
  // buys, and the commit that introduced it claimed more. A mirror already on disk is hardened on
  // the branch above, once per use, and between two uses the file is writable by anything that can
  // write the worktrees cut from it — so the pass is a reconciliation, not a lock. What makes the
  // window survivable is that the pass runs under the per-mirror mutex on every spawn and every
  // sweep, and that its second read resolves includes before it calls a mirror hardened.
  const hardened = cloned.ok
    ? await harden(ctx, repo, tmp, signal, mirror)
    : cloned;
  const placed = hardened.ok ? await moveInto(what, tmp, mirror) : hardened;
  if (placed.ok) {
    ctx.log.info({ repo: repoId, mirror }, "mirror cloned on first use");
    return ok("cloned");
  }
  try {
    await rm(tmp, { recursive: true, force: true });
  } catch (e) {
    ctx.log.error(
      { repo: repoId, tmp, error: String(e) },
      "cannot remove a failed mirror clone",
    );
  }
  return placed;
}

async function moveInto(
  what: string,
  tmp: string,
  mirror: string,
): Promise<Result<void>> {
  try {
    await rename(tmp, mirror);
    return ok(undefined);
  } catch (e) {
    return err(
      frmError(
        "spawn_failed",
        `${what}: cannot move it to ${mirror}`,
        String(e),
      ),
    );
  }
}

/**
 * `git clone --bare -- <url> <dest>` on this host through host-git.ts: its own process group,
 * killed whole on a stop or at workspace.git_timeout_ms, so no transport helper or index-pack
 * outlives it, holding the network or writing `dest`.
 *
 * `--bare`, not `--mirror` (item 3): a mirror clone writes `remote.origin.mirror=true`,
 * which makes a plain `git push` push every ref with deletions, and `fetch = +refs/*:refs/*`, under
 * which a plain `git fetch` force-updates the agent branches this mirror holds in refs/heads and a
 * `--prune` deletes the refs/frm pins. Bayon reads neither: every fetch and push it runs names its
 * refspecs. A bare clone writes neither, and carries all heads and tags just the same — what it
 * leaves behind is the refs Bayon never reads (on GitHub, refs/pull/*).
 */
async function gitClone(
  ctx: MirrorCtx,
  what: string,
  url: string,
  dest: string,
  signal: AbortSignal,
  auth: GitAuth,
): Promise<Result<void>> {
  // The credential's flags go before `clone`, so they hold for this run only: `git -c` is never
  // written into the new mirror's config, and the token itself is only in git's env.
  const ran = await hostGitRun(
    ctx,
    [...auth.flags, "clone", "--bare", "--quiet", "--", url, dest],
    {
      what,
      signal,
      stdout: "ignore",
      ...(auth.flags.length === 0 ? {} : { env: auth.env }),
    },
  );
  if (!ran.ok) return ran;
  return ran.value.code === 0 ? ok(undefined) : err(failedGit(what, ran.value));
}
