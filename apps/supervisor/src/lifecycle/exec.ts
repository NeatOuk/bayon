// One program on an executor, to its exit or a deadline (workspace.git_timeout_ms): git for the
// workspace step and a hand-off's facts, and the packet file writes. It
// goes through the executor, never the local filesystem, so a remote worktree works the same.
import { err, ok, type Result } from "@bayon/core";
import {
  GIT_ENV_FLOOR,
  type Argv,
  type Executor,
  type Proc,
} from "@bayon/executors";
import { readText, settlesWithin } from "./async-util.js";
import type { Ctx } from "./context.js";
import { asFrmError, frmError } from "./errors.js";

/** What running a program needs of the lifecycle: its limits, clock, paths and log. */
export type ExecCtx = Pick<
  Ctx,
  "settings" | "clock" | "frmHome" | "path" | "log"
>;

export interface Exited {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout ran past ArgvOptions.maxStdoutChars: the program was killed, stdout is cut. */
  readonly overflow?: true;
}

export interface ArgvOptions {
  /** What the error messages call it, e.g. `git fetch`. */
  readonly what: string;
  /** Written to stdin, which then closes. Absent: the program's stdin is ignored. */
  readonly input?: string;
  /** A stop: the program is killed and the result is `interrupted`. */
  readonly signal?: AbortSignal;
  /** Default: $FRM_HOME. An executor that places sessions (a container) needs one under the
   * session's root, where its programs run. */
  readonly cwd?: string;
  /**
   * The most stdout it may print: past it the read stops, the program is SIGKILLed and the result
   * says `overflow`, so an oversized output is never held in memory whole.
   */
  readonly maxStdoutChars?: number;
  /** Added to the program's env, under the git floor and PATH: a mirror fetch's forge token
   *. Never logged. Dropped on a non-local executor: a token goes to a child on this
   * host only (Invariant 11); a remote executor needs an explicit decision first. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Runs `argv` on the executor to its exit, whatever its code: the caller decides what a non-zero
 * one means. A stop (`signal`) or workspace.git_timeout_ms ends it: the executor SIGKILLs its
 * process group and this returns at once. A stop is `interrupted`, the deadline `timeout`.
 */
export async function runArgv(
  ctx: ExecCtx,
  executor: Executor,
  argv: Argv,
  o: ArgvOptions,
): Promise<Result<Exited>> {
  const limitMs = ctx.settings["workspace.git_timeout_ms"];
  const deadline = new AbortController();
  const disarm = new AbortController();
  ctx.clock.after(limitMs, disarm.signal).then(
    () => deadline.abort(),
    () => undefined, // disarmed: the program ended first
  );
  const abort =
    o.signal === undefined
      ? deadline.signal
      : AbortSignal.any([o.signal, deadline.signal]);
  try {
    const ran = await runToExit(ctx, executor, argv, abort, o);
    if (!ran.ok) return ran;
    if (ran.value !== "aborted") return ok(ran.value);
    if (o.signal?.aborted === true) {
      return err(frmError("interrupted", `${o.what} was stopped`));
    }
    if (deadline.signal.aborted) {
      return err(
        frmError(
          "timeout",
          `${o.what} gave no answer within ${limitMs} ms (workspace.git_timeout_ms); killed it`,
        ),
      );
    }
    return err(frmError("internal", `${o.what} was aborted`));
  } finally {
    disarm.abort();
  }
}

/** Runs the program to its exit, or until `abort`: then the exit alone is awaited, and not forever. */
async function runToExit(
  ctx: ExecCtx,
  executor: Executor,
  argv: Argv,
  abort: AbortSignal,
  o: Pick<ArgvOptions, "input" | "maxStdoutChars" | "cwd" | "env">,
): Promise<Result<Exited | "aborted">> {
  const { input } = o;
  let proc: Proc;
  try {
    proc = await executor.exec(argv, {
      cwd: o.cwd ?? ctx.frmHome,
      // An executor's own PATH where its programs are not ours (a container's image); the git
      // floor on every argv the supervisor runs, since several of them are git.
      env: {
        ...(executor.kind === "local" ? o.env : undefined),
        ...GIT_ENV_FLOOR,
        PATH: executor.envPath ?? ctx.path,
      },
      stdin: input === undefined ? "ignore" : "pipe",
      signal: abort,
    });
  } catch (e) {
    return err(asFrmError(e, "spawn_failed", `cannot run ${argv[0]}`));
  }
  const started = proc;
  let overflow = false;
  const output = Promise.all([
    readText(proc.stdout, o.maxStdoutChars, () => {
      overflow = true;
      started.kill("SIGKILL");
    }),
    readText(proc.stderr),
    proc.exited,
    feed(proc, input),
  ]);
  const aborted = whenAborted(abort);
  try {
    const first = await Promise.race([output, aborted.promise]);
    if (first === "aborted") {
      // The pipes may outlive the group SIGKILL (a descendant that left it): never wait on them.
      const grace = ctx.settings["lifecycle.kill_grace_ms"];
      if (!(await settlesWithin(proc.exited, ctx.clock, grace))) {
        ctx.log.error(
          { ref: proc.ref },
          `${argv[0]} did not exit after SIGKILL`,
        );
      }
      return ok("aborted");
    }
    const [stdout, stderr, status] = first;
    return ok({
      code: status.code,
      stdout,
      stderr,
      ...(overflow ? { overflow: true as const } : {}),
    });
  } finally {
    aborted.dispose();
  }
}

/** Writes `input` to the program's stdin and closes it; a program that exits early is fine. */
async function feed(proc: Proc, input: string | undefined): Promise<void> {
  if (input === undefined || proc.stdin === null) return;
  try {
    await proc.stdin.write(input);
    await proc.stdin.end();
  } catch {
    // The exit code says whether the program got what it needed.
  }
}

/** Resolves once `signal` aborts; `dispose` drops the listener. */
function whenAborted(signal: AbortSignal): {
  readonly promise: Promise<"aborted">;
  dispose(): void;
} {
  const { promise, resolve } = Promise.withResolvers<"aborted">();
  const onAbort = (): void => resolve("aborted");
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/** A non-zero exit as an error, with the tail of its stderr. */
export function exitedOk(ran: Result<Exited>, what: string): Result<Exited> {
  if (!ran.ok || ran.value.code === 0) return ran;
  return err(
    frmError(
      "spawn_failed",
      `${what} failed: ${ran.value.stderr.trim().slice(-500)}`,
    ),
  );
}
