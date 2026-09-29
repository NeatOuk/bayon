// Archive bundles: before a removal that rests on a ref an agent can
// delete (a `fetch --prune` in any worktree of a mirror clone prunes every local-only ref, g19),
// what only that ref holds goes into $FRM_HOME/archive/worktrees, 0700/0600, verified, renamed into
// place, the directory fsynced. It only adds a file; the sweep never deletes one.
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { frmError } from "../errors.js";
import { failedGit } from "../host-git.js";
import type { SweepDeps } from "./deps.js";
import { sweepGitRun } from "./git.js";

export const archiveDir = (frmHome: string): string =>
  join(frmHome, "archive", "worktrees");

export interface BundleSpec {
  /** The file's name without `.bundle`: the row id, or `<row id>.<n>` for a module. */
  readonly name: string;
  /** Where `git bundle create` runs: the worktree, or a module's gitdir. */
  readonly dir: string;
  readonly revs: readonly string[];
  /** A commit the bundle may leave out (the base); null makes it complete. */
  readonly not: string | null;
  /** The repo whose objects satisfy the bundle's prerequisites: the mirror, or the child's. */
  readonly verifyIn: string;
}

/** Writes and verifies one bundle, resolving to its path. Never touches a ref. */
export async function writeBundle(
  deps: SweepDeps,
  spec: BundleSpec,
): Promise<Result<string>> {
  const dir = archiveDir(deps.frmHome);
  const tmp = join(dir, `${spec.name}.bundle.tmp`);
  const final = join(dir, `${spec.name}.bundle`);
  // The steps past this point are not the stop signal's: a half-written bundle helps nobody.
  const signal = new AbortController().signal;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await rm(tmp, { force: true });
  } catch (e) {
    return err(frmError("internal", `cannot prepare ${dir}`, String(e)));
  }
  const create = [
    "-C",
    spec.dir,
    "bundle",
    "create",
    "-q",
    tmp,
    ...spec.revs,
    ...(spec.not === null ? [] : ["--not", spec.not]),
  ];
  const made = await sweepGitRun(deps, create, signal);
  if (!made.ok) return made;
  if (made.value.code !== 0)
    return err(failedGit("git bundle create", made.value));
  const verified = await sweepGitRun(
    deps,
    ["-C", spec.verifyIn, "bundle", "verify", "-q", tmp],
    signal,
  );
  if (!verified.ok) return verified;
  if (verified.value.code !== 0) {
    return err(failedGit("git bundle verify", verified.value));
  }
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, final);
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (e) {
    return err(frmError("internal", `cannot place ${final}`, String(e)));
  }
  return ok(final);
}
