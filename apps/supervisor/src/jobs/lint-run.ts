// Running the repo's own commands for a `lint_check` gate. Separated from the child
// entry point (lint-check.ts) so the part worth testing -- what an install failure means, what a
// lint failure means, what is written where -- can be driven against a real temp directory and a
// real child process, with no session and no database.
//
// The commands come from `repos.install_cmd` and `repos.lint_cmd` and are run as **argv, with no
// shell** (core's `lintArgv`, and the rule pulse/probe-shell.ts states). They are still
// repo-controlled code: `pnpm -w lint` resolves through a `package.json` script the builder could
// have edited. That is why this runs in the gate's session rather than in the gate engine, why the
// child's whole environment is job-env.ts's (an allowlist under a floor that confines it to this
// session's own home), and why it is its own process group so that a stop takes the
// whole tree and not just the package manager that fronts it.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  err,
  lintCommandLine,
  lintTail,
  ok,
  type LintRun,
  type Result,
} from "@bayon/core";
import { frmError } from "../lifecycle/errors.js";
import { envFloor, repoCommandEnv, type JobHome } from "./job-env.js";

/** The most of one command's output held in memory; past it the process is killed. */
export const LINT_OUTPUT_MAX = 1_000_000;

/** What one command did. */
export interface Exited {
  readonly code: number | null;
  /** stdout and stderr, interleaved as written, capped at LINT_OUTPUT_MAX. */
  readonly output: string;
  /** The cap was reached and the process killed. */
  readonly overflow: boolean;
}

/**
 * Runs one argv in `cwd` to its exit, whatever its code. Never rejects.
 *
 * The child is **its own process group**, and a stop or the output cap SIGKILLs the whole group —
 * the two lessons packages/executors' git.ts already learned, copied rather than relearned:
 *
 *   - `pnpm -w lint` is a supervisor of its own. Killing the direct child (node's `signal` option
 *     does that, and so does `child.kill`) leaves every descendant running, as the supervisor's own
 *     uid, in a repo-controlled script, after the kill switch or the gate clock has already said
 *     stop. `process.kill(-pid)` is the whole tree.
 *   - `close` fires when the last pipe is closed, which a grandchild holding stdout can delay
 *     indefinitely. After a kill the child's own `exit` is enough (local/local.ts says the same).
 */
export function runCommand(
  argv: readonly [string, ...string[]],
  o: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    /** This session's own home and tmp: the floor repoCommandEnv confines the child to. */
    readonly at: JobHome;
    readonly signal?: AbortSignal;
    /** The output cap; LINT_OUTPUT_MAX by default (the QA job passes its own). */
    readonly max?: number;
    /**
     * Names to put in the child's environment **past the allowlist**: the host-store
     * secrets a project's QA harness declared by name (§14). Deliberately narrow — the allowlist
     * exists so that nothing of ours reaches project code by accident, and this is the one door
     * that is meant to, opened per run by an operator who named each secret.
     *
     * The floor still wins over it: `envFloor` is applied last, so a secret named `HOME` (which the
     * name rule would otherwise allow) cannot move a harness out of its session's own directory.
     */
    readonly inject?: Readonly<Record<string, string>>;
  },
): Promise<Exited> {
  const max = o.max ?? LINT_OUTPUT_MAX;
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    const child = spawn(command, args, {
      cwd: o.cwd,
      env: {
        ...repoCommandEnv(o.env, o.at),
        ...(o.inject ?? {}),
        ...envFloor(o.at),
      },
      detached: true,
      // No stdin. The default is a pipe nobody ever writes to or ends, so a command that asks a
      // question -- a package manager wanting a confirmation, a linter offering to fix -- blocks on
      // a read that can only end at the gate's wall clock. `ignore` makes that an immediate EOF.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let overflow = false;
    let killed = false;
    const killGroup = (): void => {
      killed = true;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is gone already.
      }
    };
    const onAbort = (): void => killGroup();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.signal?.aborted === true) onAbort();
    let settled = false;
    const settle = (e: Exited): void => {
      if (settled) return;
      settled = true;
      o.signal?.removeEventListener("abort", onAbort);
      resolve(e);
    };
    /**
     * One decoder per stream. A pipe read ends wherever the kernel filled the buffer, which is
     * routinely in the middle of a UTF-8 sequence: `Buffer.toString("utf8")` per chunk turns one
     * such character into two replacement characters, in the very tail a finding quotes. A
     * `StringDecoder` holds the partial bytes until the next chunk completes them. The two streams
     * are independent byte streams, so they cannot share one.
     */
    const taker = (): ((d: Buffer) => void) => {
      const decoder = new StringDecoder("utf8");
      return (d) => {
        if (overflow) return;
        const text = decoder.write(d);
        if (text === "") return;
        // Tested with the chunk counted, not after it is appended: the other way round the last
        // chunk lands whole past the cap.
        if (output.length + text.length > max) {
          overflow = true;
          killGroup();
          return;
        }
        output += text;
      };
    };
    child.stdout.on("data", taker());
    child.stderr.on("data", taker());
    // A command that is not on PATH never runs at all: an `error`, not an exit. Reported as the
    // same shape with no code, so the finding says "did not exit normally" rather than passing.
    child.on("error", (e: Error) =>
      settle({ code: null, output: `${output}${e.message}`, overflow }),
    );
    child.on("exit", (code) => {
      if (killed) settle({ code, output, overflow });
    });
    child.on("close", (code) => settle({ code, output, overflow }));
  });
}

export interface LintJobInput {
  /** The worktree the gate pinned: the session's cwd. */
  readonly cwd: string;
  readonly repoId: string;
  /** `repos.install_cmd` as an argv, or null when the repo declares none. */
  readonly install: readonly string[] | null;
  /** `repos.lint_cmd` as an argv. */
  readonly lint: readonly [string, ...string[]];
  /** Where the whole output goes (Invariant 9): the finding names it. */
  readonly logPath: string;
  /** The job's own environment, which the child's is an allowlist over (job-env.ts). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * This session's private home and tmp (`jobHome`), which every command below is confined to:
   * repo-declared code writes its `.gitconfig`, `.npmrc` and caches there and nowhere the
   * supervisor or another session reads (§9.8).
   */
  readonly at: JobHome;
  readonly signal?: AbortSignal;
}

const banner = (argv: readonly string[], e: Exited): string =>
  [
    `$ ${argv.join(" ")}`,
    e.output,
    `[exit ${e.code === null ? "none" : String(e.code)}${e.overflow ? ", output truncated" : ""}]`,
    "",
  ].join("\n");

/**
 * Installs (when the repo declares a command) and then lints, writing both commands' whole output
 * to `logPath`.
 *
 * The two failures are **not** the same thing, and the difference is the whole point of running
 * install here rather than assuming a warm worktree:
 *
 *   - the install failing is an infrastructure failure. It is an `err`, which the caller turns into
 *     a failed terminal event, so the gate ends `reviewer_error` -- a thing to fix in the fleet,
 *     not a finding for the builder to answer.
 *   - the lint command failing is the answer the gate exists for. It is `ok`, with a `LintRun` the
 *     caller turns into one blocker finding naming the command.
 *
 * Without the install, a fresh detached worktree has no `node_modules`, so the lint command would
 * exit non-zero for a missing dependency and the builder would be handed a finding blaming its
 * change for the fleet's empty cache.
 */
export async function runLintJob(i: LintJobInput): Promise<Result<LintRun>> {
  const parts: string[] = [];
  const write = async (): Promise<Result<void>> => {
    try {
      await mkdir(dirname(i.logPath), { recursive: true, mode: 0o700 });
      await writeFile(i.logPath, parts.join("\n"), { mode: 0o600 });
      return ok(undefined);
    } catch (e) {
      return err(frmError("internal", `cannot write ${i.logPath}`, String(e)));
    }
  };
  if (i.install !== null && i.install.length > 0) {
    const [head = "", ...rest] = i.install;
    const ran = await runCommand([head, ...rest], i);
    parts.push(banner(i.install, ran));
    if (ran.code !== 0) {
      // The log is what this message points at, and the install's output is carried nowhere else:
      // discarding this Result left the error naming a file that does not exist, with the only copy
      // of what went wrong gone. Checked, as the lint path below already checks it, and when it
      // fails the tail travels inline instead of the path (Invariant 9 keeps the rest capped).
      const written = await write();
      return err(
        frmError(
          "internal",
          `the repo's install command \`${lintCommandLine(i.install)}\` exited ${ran.code === null ? "abnormally" : String(ran.code)} in repo ${i.repoId}: the gate could not be run, so it decides nothing about this change. ${
            written.ok
              ? `Full output: ${i.logPath}`
              : `${written.error.message}, so its last lines are here instead:\n${lintTail(ran.output)}`
          }`,
        ),
      );
    }
  }
  const ran = await runCommand(i.lint, i);
  parts.push(banner(i.lint, ran));
  const written = await write();
  if (!written.ok) return written;
  // The cap killed it, so its exit code is ours and not the command's (`code: null` after a
  // SIGKILL). `lintFindings` would read that as "did not exit normally" and blame the builder's
  // change for a blocker -- for a lint that may well have been about to exit 0, on a verbose
  // monorepo. We killed it, so it is an `err`: the caller fails the run, the gate ends
  // `reviewer_error`, and that is a fleet problem to fix, exactly as an install failure is.
  if (ran.overflow) {
    return err(
      frmError(
        "internal",
        `the repo's lint command \`${lintCommandLine(i.lint)}\` wrote more than ${String(LINT_OUTPUT_MAX)} characters in repo ${i.repoId} and was killed at the cap: what it would have exited with is unknown, so the gate decides nothing about this change. Full output: ${i.logPath}`,
      ),
    );
  }
  return ok({
    argv: i.lint,
    exitCode: ran.code,
    output: ran.output,
    logPath: i.logPath,
  });
}
