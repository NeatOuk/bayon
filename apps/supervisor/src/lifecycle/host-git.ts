// Git on this host, on the supervisor's own mirrors: git is its own process
// group, and a stop or workspace.git_timeout_ms SIGKILLs the whole group, so no transport helper
// (git-remote-*, ssh) or index-pack outlives it (ticket comment, as mirror clone). Every
// call, here and through an executor, carries SAFE_GIT: a hook or fsmonitor configured on a shared
// mirror never runs in the supervisor (M2). The flags and the group spawn live in @bayon/executors'
// git.ts, which the container executor's mirror push shares: one source of truth.
import { err, ok, type Result } from "@bayon/core";
import { GIT_STDOUT_CAP, gitSubcommand, runGitGroup } from "@bayon/executors";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";

export { gitSubcommand, SAFE_GIT, safeGitArgs } from "@bayon/executors";

/** What host git needs of the lifecycle: the deadline, its clock, PATH and log. */
export type HostGitCtx = Pick<Ctx, "settings" | "clock" | "path">;

export interface HostRan {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const STDERR_TAIL = 500;

/** A non-zero exit as the error every git step reports. */
export const failedGit = (
  what: string,
  r: Pick<HostRan, "code" | "stderr">,
): ReturnType<typeof frmError> =>
  frmError(
    "spawn_failed",
    `${what} failed: ${r.stderr.trim().slice(-STDERR_TAIL) || `exit ${String(r.code)}`}`,
  );

/**
 * `git <SAFE_GIT> <args>` on this host, to its exit whatever its code. A stop is `interrupted`,
 * workspace.git_timeout_ms `timeout`, stdout past 16 MiB `spawn_failed`: each kills the group.
 */
export async function hostGitRun(
  ctx: HostGitCtx,
  args: readonly string[],
  o: {
    readonly what: string;
    readonly signal: AbortSignal;
    readonly stdout?: "capture" | "ignore";
    /** Added to git's env (a fixed identity, no system config: fixture). */
    readonly env?: Readonly<Record<string, string>>;
    /** Replaces workspace.git_timeout_ms for this call (the sweep's worktree remove, an earlier change L5). */
    readonly limitMs?: number;
  },
): Promise<Result<HostRan>> {
  const limitMs = o.limitMs ?? ctx.settings["workspace.git_timeout_ms"];
  const deadline = new AbortController();
  const disarm = new AbortController();
  ctx.clock.after(limitMs, disarm.signal).then(
    () => deadline.abort(),
    () => undefined, // disarmed: git ended first
  );
  const ran = await runGitGroup(args, {
    what: o.what,
    // runGitGroup lays GIT_ENV_FLOOR under this.
    env: { PATH: ctx.path, ...o.env },
    signal: AbortSignal.any([o.signal, deadline.signal]),
    stdout: o.stdout ?? "capture",
  });
  disarm.abort();
  if (!ran.ok) return ran;
  const { code, stdout, stderr, killed } = ran.value;
  const overflow = killed === "overflow";
  if (code === 0 && !overflow) return ok({ code, stdout, stderr });
  if (o.signal.aborted) {
    return err(frmError("interrupted", `${o.what} was stopped`));
  }
  if (deadline.signal.aborted) {
    return err(
      frmError(
        "timeout",
        `${o.what} gave no answer within ${limitMs} ms${o.limitMs === undefined ? " (workspace.git_timeout_ms)" : ""}; killed it`,
      ),
    );
  }
  if (overflow) {
    return err(
      frmError(
        "spawn_failed",
        `${o.what} printed more than ${GIT_STDOUT_CAP} bytes; killed it`,
      ),
    );
  }
  return ok({ code, stdout, stderr });
}

/** `git -C <gitDir> <args>` on this host: stdout on exit 0, any other exit `spawn_failed`. */
export async function hostGit(
  ctx: HostGitCtx,
  gitDir: string,
  args: readonly string[],
  signal: AbortSignal,
  o: {
    readonly trim?: boolean;
    /** Added to git's env (fixture: a fixed identity, no system config). */
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<Result<string>> {
  const what = `git ${gitSubcommand(args)}`;
  const ran = await hostGitRun(ctx, ["-C", gitDir, ...args], {
    what,
    signal,
    ...(o.env === undefined ? {} : { env: o.env }),
  });
  if (!ran.ok) return ran;
  if (ran.value.code !== 0) return err(failedGit(what, ran.value));
  return ok(o.trim === false ? ran.value.stdout : ran.value.stdout.trim());
}
