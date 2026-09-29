// The lint checker's child process: the `script` runner's argv points here. Read-only
// on the DB -- it writes no row; `decideGate` is the gate's only writer (rule 2) and the gate engine
// calls it from this session's afterExit. Speaks the same tiny stdin/stdout protocol every script
// job speaks (`@bayon/runners/script`): wait for `send`, emit canonical JSONL, exit only on stdin
// EOF.
//
// Its one answer is an `assistant_text` carrying `lintReport`: the findings as an embedded
// ReviewOutput JSON and the `FINDINGS: <n>` sentinel, which is what a runner without `outputSchema`
// is held to (and `collect()` checks the two agree).
//
// It works in the gate's pinned worktree: `sessionRoots` gives a session with a `gate_id` its one
// worktree as cwd, which is the commit under review checked out detached. That is the difference
// from the parity job, which takes no worktree at all -- a lint command has to have the files.
import { randomUUID } from "node:crypto";
import { lintArgv, lintFindings, lintReport, systemClock } from "@bayon/core";
import { getRepo, openDbReadOnly } from "@bayon/db";
import { emit, readOps, type ScriptIo } from "@bayon/runners/script";
import { z } from "zod";
import { jobHome } from "./job-env.js";
import { LINT_LOG_ENV, LINT_REPO_ENV } from "./lint-agent.js";
import { runLintJob } from "./lint-run.js";
import { pump } from "./script-pump.js";

/**
 * The job's whole input. Both lint names carry what the gate pinned and are **required**: a job
 * that guessed its repo would lint one repo of a workspace and report the answer as another's, and
 * a job with nowhere to put the output would either drop it or push thousands of lines into an
 * event payload (Invariant 9).
 *
 * `FRM_HOME` and `HOME` are required for the other reason: `jobHome` recomputes this
 * session's private home from the first and holds the second to it, so a repo's declared commands
 * cannot be run under a home this session does not own.
 */
const Env = z.object({
  FRM_DB: z.string().min(1),
  FRM_HOME: z.string().min(1),
  FRM_SESSION_ID: z.string().min(1),
  HOME: z.string().min(1),
  [LINT_REPO_ENV]: z.string().min(1),
  [LINT_LOG_ENV]: z.string().min(1),
});

const ZERO_USAGE = {
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
};

function fail(io: ScriptIo, message: string): void {
  const error = { class: "internal", message, retryable: false };
  emit(io, { kind: "error", runner_type: "lint.error", payload: error });
  emit(io, {
    kind: "terminal",
    runner_type: "lint.terminal",
    payload: { outcome: "failed", error, usage: ZERO_USAGE, cost_usd: 0 },
  });
}

async function runOnce(io: ScriptIo, signal: AbortSignal): Promise<void> {
  emit(io, {
    kind: "session_init",
    runner_type: "lint.init",
    payload: { runner_session_id: randomUUID(), model: "script" },
  });

  const env = Env.safeParse(process.env);
  if (!env.success)
    return fail(io, `bad environment: ${z.prettifyError(env.error)}`);
  const repoId = env.data[LINT_REPO_ENV];
  // Before the database, before the repo row, and a long way before a repo-declared command: the
  // session-private home those commands are confined to, recomputed rather than inherited
  //. A disagreement is a failed gate, never a lint run with somebody else's home.
  const at = jobHome(process.env);
  if (!at.ok) return fail(io, at.error.message);

  const db = await openDbReadOnly({
    path: env.data.FRM_DB,
    clock: systemClock,
  });
  if (!db.ok)
    return fail(io, `cannot open the database read-only: ${db.error.message}`);

  try {
    const repo = await getRepo(db.value, repoId);
    if (!repo.ok) return fail(io, repo.error.message);
    // No command is a failure, never a clean pass: a gate that ran nothing and reported a clean
    // repo would certify a tree it never looked at (Invariant 10, and parity's H1 rule). The
    // message names the row to set. Since an earlier change a round opens this gate only for repos that
    // declare a command, so reaching here means the row was cleared between the plan and the run —
    // a race, not the ordinary case it used to be when one repo's command opened every repo's gate.
    const lint = lintArgv(repo.value.lint_cmd);
    if (!lint.ok) return fail(io, `repo ${repoId}: ${lint.error.message}`);
    const [head = "", ...rest] = lint.value;
    // install_cmd is optional; a bad one is refused rather than run as literal arguments.
    const install =
      (repo.value.install_cmd ?? "").trim() === ""
        ? { ok: true as const, value: null }
        : lintArgv(repo.value.install_cmd);
    if (!install.ok)
      return fail(io, `repo ${repoId} install_cmd: ${install.error.message}`);

    const ran = await runLintJob({
      cwd: process.cwd(),
      repoId,
      install: install.value,
      lint: [head, ...rest],
      logPath: env.data[LINT_LOG_ENV],
      env: process.env,
      at: at.value,
      signal,
    });
    if (!ran.ok) return fail(io, ran.error.message);
    const findings = lintFindings(repoId, ran.value);
    emit(io, {
      kind: "assistant_text",
      runner_type: "lint.report",
      text: lintReport(repoId, findings),
      payload: {},
    });
    emit(io, {
      kind: "terminal",
      runner_type: "lint.terminal",
      payload: {
        outcome: "ok",
        usage: ZERO_USAGE,
        cost_usd: 0,
        repo_id: repoId,
        exit_code: ran.value.exitCode,
        findings: findings.length,
      },
    });
  } catch (e) {
    fail(io, e instanceof Error ? e.message : String(e));
  } finally {
    await db.value.close();
  }
}

/**
 * Reads stdin to its end regardless of what `runOnce` did: the job exits only on stdin EOF (never
 * self-terminates), exactly like the parity job and the exporter. `pump` is what keeps stdin read
 * *while* the repo's install and lint commands run — which is this job's entire life, and so the
 * only window in which an `interrupt` can reach the signal `runCommand` kills its group on.
 */
async function main(): Promise<void> {
  const io: ScriptIo = {
    stdout: { write: (chunk) => void process.stdout.write(chunk) },
  };
  try {
    await pump(readOps(process.stdin), (signal) => runOnce(io, signal));
  } catch (e) {
    fail(io, e instanceof Error ? e.message : String(e));
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && entry.endsWith("lint-check.js");
}

if (isMain()) {
  await main();
  process.exitCode = 0;
}
