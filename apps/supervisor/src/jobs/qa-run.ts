// Running a project's own QA harness for a `qa_harness` gate. Separated from the child
// entry point (qa-check.ts) so the part worth testing -- what a timeout means, what a missing secret
// means, what is written where -- can be driven against a real temp directory and a real child
// process, with no session and no database.
//
// The command comes from `workspaces.qa_cmd` and is run as **argv, with no shell** (core's
// `qaArgv`). It is still project-controlled code, so it runs in the gate's own session, its whole
// environment is job-env.ts's allowlist under a floor that confines it to this session's home
//, and it is its own process group so a stop takes the whole tree.
//
// Nothing in this file knows what a project's harness *is*. It runs an argv, reads an exit code,
// copies whatever the project's own globs matched, and hands the answer to core.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  QA_OUTPUT_MAX,
  err,
  matchGlob,
  ok,
  qaArgv,
  qaJunit,
  qaSubstitute,
  qaVerdict,
  scrubSecrets,
  type QaConfigFields,
  type QaOutcome,
  type QaSecret,
  type QaValues,
  type Result,
  type ReviewFinding,
} from "@bayon/core";
import { frmError } from "../lifecycle/errors.js";
import { QA_LOG, QA_REPORTS_DIR, QA_RUN_FILE } from "./qa-agent.js";
import type { JobHome } from "./job-env.js";
import { runCommand } from "./lint-run.js";
import { collectReports } from "./qa-reports.js";

/** A resolved secret: core's own pair, so the scrub and its input have one definition. */
export type ResolvedSecret = QaSecret;

export interface QaJobInput {
  /** The worktree the gate pinned: the harness's cwd. */
  readonly cwd: string;
  /** The project whose harness this is. */
  readonly workspaceId: string;
  readonly config: QaConfigFields;
  /** The placeholder values: the ticket's key, its external key and its branch. */
  readonly values: QaValues;
  /** The names resolved from the host secret store, put in the harness's env and nowhere else. */
  readonly secrets: readonly ResolvedSecret[];
  /** The gate's artifacts directory on this host: the log, the run file and the reports. */
  readonly artifactsDir: string;
  /** The job's own environment, which the harness's is an allowlist over (job-env.ts). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This session's private home and tmp, which the harness is confined to (§9.8). */
  readonly at: JobHome;
  /** The harness's own wall clock, already bounded (`qaTimeoutOf`). */
  readonly timeoutMs: number;
  /** The gate's stop signal. */
  readonly signal?: AbortSignal;
  readonly now: () => number;
}

/** What the job hands back: the verdict, and the facts the evidence records. */
export interface QaJobResult {
  readonly outcome: QaOutcome;
  readonly command: string;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number;
  /** Where the reports were copied, for `GateEvidence.qa.reports` and `artifact_paths`. */
  readonly reports: readonly string[];
  /** Of those, the ones that are not text: copied byte for byte, and so never scrubbed. */
  readonly binaryReports: readonly string[];
  readonly logPath: string;
  /** The run's facts on disk, so `collect()` can read them without the job's process. */
  readonly runPath: string;
}

const banner = (
  argv: readonly string[],
  code: number | null,
  overflow: boolean,
  output: string,
  timedOut: boolean,
): string =>
  [
    `$ ${argv.join(" ")}`,
    output,
    `[exit ${code === null ? "none" : String(code)}${overflow ? ", output truncated at the cap" : ""}${timedOut ? ", killed at the harness timeout" : ""}]`,
    "",
  ].join("\n");

/**
 * Runs the project's harness and writes everything it left behind.
 *
 * Two failures are not the same thing, and keeping them apart is the point of the whole gate:
 *
 *   - the harness running and exiting non-zero is the answer the gate exists for. `qaVerdict` turns
 *     it into blocking findings, the ticket goes to `rework`, and a fixer is staffed.
 *   - the harness not running at all — a command that is not there, a missing device, a secret the
 *     host store does not hold, our own timeout or output cap — judged nothing. It is a
 *     `reviewer_error`, which `isCodeFailure` keeps off the fix path, and the operator
 *     sees a stuck gate rather than a fixer sent after a bug that does not exist.
 */
export async function runQaJob(i: QaJobInput): Promise<Result<QaJobResult>> {
  // Checked here as well as at the door it was set through: the row could have been cleared or
  // edited between the round that opened the gate and this run, and a refusal is a reviewer error
  // (nothing judged the code) rather than a command run half way.
  const declared = qaArgv(i.config.cmd);
  if (!declared.ok) {
    return err(
      frmError(
        "validation",
        `project ${i.workspaceId}: ${declared.error.message}`,
      ),
    );
  }
  const argv = qaSubstitute(declared.value, i.values);
  const [head = "", ...rest] = argv;
  const logPath = join(i.artifactsDir, QA_LOG);
  const runPath = join(i.artifactsDir, QA_RUN_FILE);
  const startedAt = i.now();
  // Our own clock on top of the gate's: a project sets how long its harness may take, and a harness
  // that runs past it is killed by us, so the exit is ours and not the project's (see below).
  const timer = AbortSignal.timeout(i.timeoutMs);
  const stop = AbortSignal.any(
    i.signal === undefined ? [timer] : [timer, i.signal],
  );
  const ran = await runCommand([head, ...rest], {
    cwd: i.cwd,
    env: i.env,
    at: i.at,
    signal: stop,
    max: QA_OUTPUT_MAX,
    // Past the allowlist on purpose, and only these: the names the operator declared (§14).
    inject: Object.fromEntries(i.secrets),
  });
  const endedAt = i.now();
  const timedOut = timer.aborted;
  // Scrubbed before anything keeps it: the log on disk, the tail in a finding and any error message
  // all come from here (§14, Invariant 11).
  const output = scrubSecrets(ran.output, i.secrets);
  const written = await write(
    logPath,
    banner(argv, ran.code, ran.overflow, output, timedOut),
  );
  if (!written.ok) return written;

  const command = argv.join(" ");
  // Scrubbed on the way in, the same values and the same helper the output went through: a harness
  // echoes what it was given into its report as readily as onto its stdout (§14, Invariant 11).
  const reports = await collectReports(
    i.cwd,
    i.config.reports,
    join(i.artifactsDir, QA_REPORTS_DIR),
    i.secrets,
  );
  if (!reports.ok) return reports;
  const paths = reports.value.reports.map((r) => r.path);
  // The ones that are not text: copied byte for byte, so **not** scrubbed. Named in the evidence
  // rather than quietly mixed in with the rest.
  const binary = reports.value.reports
    .filter((r) => r.binary)
    .map((r) => r.path);

  // We killed it, so its exit code is ours, not the harness's (`code: null` after a SIGKILL).
  // Reading that as "the change is broken" would blame a builder for our own cap or clock.
  const outcome: QaOutcome =
    timedOut || ran.overflow
      ? {
          state: "reviewer_error",
          message: timedOut
            ? `the QA command \`${command}\` was killed at this project's ${String(i.timeoutMs)} ms harness timeout: what it would have exited with is unknown, so the gate decides nothing about this change. Full output: ${logPath}`
            : `the QA command \`${command}\` wrote more than ${String(QA_OUTPUT_MAX)} characters and was killed at the cap: what it would have exited with is unknown, so the gate decides nothing about this change. Full output: ${logPath}`,
        }
      : qaVerdict({
          argv,
          exitCode: ran.code,
          output,
          logPath,
          ...(await junitOf(i, paths, i.config.junit)),
        });

  const facts = {
    command,
    exit_code: ran.code,
    started_at: startedAt,
    ended_at: endedAt,
    reports: paths,
    ...(binary.length === 0 ? {} : { binary_reports: binary }),
  };
  const recorded = await write(runPath, `${JSON.stringify(facts, null, 2)}\n`);
  if (!recorded.ok) return recorded;
  return ok({
    outcome,
    command,
    exitCode: ran.code,
    startedAt,
    endedAt,
    reports: paths,
    binaryReports: binary,
    logPath,
    runPath,
  });
}

/**
 * The JUnit report the project named, read from the copies; absent or unreadable adds nothing.
 *
 * The copy it reads is already scrubbed (`collectReports`), and `qaJunit` scrubs again on both
 * sides of the parse. That is three passes over the same bytes on purpose: this is the one path
 * where a harness's own text becomes a finding's `detail_md`, and a finding's `detail_md` is
 * compiled into the next fix session's prompt (§8.2). A miss here is a secret in a prompt.
 */
async function junitOf(
  i: QaJobInput,
  copied: readonly string[],
  glob: string | null,
): Promise<{ junit?: ReturnType<typeof qaJunit> }> {
  if (glob === null || glob.trim() === "") return {};
  const base = join(i.artifactsDir, QA_REPORTS_DIR);
  const found = copied.find((path) => {
    const rel = path.startsWith(base) ? path.slice(base.length + 1) : path;
    return matchGlob(glob, rel.split("\\").join("/"));
  });
  if (found === undefined) return {};
  try {
    return { junit: qaJunit(await readFile(found, "utf8"), i.secrets) };
  } catch {
    return {};
  }
}

/** The findings a verdict carries; a reviewer error carries none (the gate fails without them). */
export const qaFindingsOf = (outcome: QaOutcome): readonly ReviewFinding[] =>
  outcome.state === "failed" ? outcome.findings : [];

async function write(path: string, text: string): Promise<Result<void>> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, text, { mode: 0o600 });
    return ok(undefined);
  } catch (e) {
    return err(frmError("internal", `cannot write ${path}`, String(e)));
  }
}
