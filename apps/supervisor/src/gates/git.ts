// Git for the gate engine: argv through the executor that holds the
// worktree, never a shell, each command under workspace.git_timeout_ms (runArgv). The flags come
// from packages/executors' safeGitArgs, so the worktree being agent-writable is the one
// place's problem, not this one's — note the read-only lock flag is now added per subcommand there,
// where this added it to every call.
import { err, ok, type Result } from "@bayon/core";
import { safeGitArgs, type Executor } from "@bayon/executors";
import { frmError } from "../lifecycle/errors.js";
import { runArgv, type ExecCtx } from "../lifecycle/exec.js";

export interface GitCtx {
  readonly exec: ExecCtx;
  readonly executor: Executor;
}

/**
 * `git -C dir args…`'s stdout as printed, on exit 0; any other end is an error naming it.
 *
 * `cwd` is where the command runs, for an executor that places sessions itself: a container routes
 * by cwd, so reading a worktree there needs the worktree as the cwd and not this host's FRM_HOME
 *. Left out for the mirrors, which are the supervisor's own.
 */
export async function gitRaw(
  g: GitCtx,
  dir: string,
  args: readonly string[],
  cwd?: string,
): Promise<Result<string>> {
  const what = `git ${args[0] ?? ""}`;
  const ran = await runArgv(
    g.exec,
    g.executor,
    ["git", ...safeGitArgs(["-C", dir, ...args])],
    { what, ...(cwd === undefined ? {} : { cwd }) },
  );
  if (!ran.ok) return ran;
  if (ran.value.code === 0) return ok(ran.value.stdout);
  const why = ran.value.stderr.trim().slice(0, 300);
  return err(
    frmError("internal", `${what} exited ${String(ran.value.code)}: ${why}`),
  );
}

/** gitRaw, trimmed: for one-line answers (a sha). */
export async function git(
  g: GitCtx,
  dir: string,
  args: readonly string[],
  cwd?: string,
): Promise<Result<string>> {
  const out = await gitRaw(g, dir, args, cwd);
  return out.ok ? ok(out.value.trim()) : out;
}
