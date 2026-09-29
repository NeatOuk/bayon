// Host git for the sweep: host-git.ts's process group, SAFE_GIT and deadline,
// plus GIT_NO_LAZY_FETCH on every call (L3). The worktree's paths are this host's, so no executor.
import { err, ok, type Result } from "@bayon/core";
import {
  failedGit,
  gitSubcommand,
  hostGitRun,
  type HostGitCtx,
  type HostRan,
} from "../host-git.js";
import { SWEEP_ENV } from "./argv.js";

/**
 * git to its exit, whatever its code. `limitMs` replaces workspace.git_timeout_ms (L5); `env` is
 * added beside SWEEP_ENV (a base fetch's forge token).
 */
export function sweepGitRun(
  ctx: HostGitCtx,
  args: readonly string[],
  signal: AbortSignal,
  limitMs?: number,
  env?: Readonly<Record<string, string>>,
): Promise<Result<HostRan>> {
  return hostGitRun(ctx, args, {
    what: `git ${gitSubcommand(args)}`,
    signal,
    env: { ...env, ...SWEEP_ENV },
    ...(limitMs === undefined ? {} : { limitMs }),
  });
}

/** git's stdout on exit 0 (trimmed unless `trim: false`); any other exit is `spawn_failed`. */
export async function sweepGit(
  ctx: HostGitCtx,
  args: readonly string[],
  signal: AbortSignal,
  o: { readonly trim?: boolean } = {},
): Promise<Result<string>> {
  const ran = await sweepGitRun(ctx, args, signal);
  if (!ran.ok) return ran;
  if (ran.value.code !== 0) {
    return err(failedGit(`git ${gitSubcommand(args)}`, ran.value));
  }
  return ok(o.trim === false ? ran.value.stdout : ran.value.stdout.trim());
}
