import type { Result } from "../errors.js";
import {
  ARGV_WORDS_MAX,
  COMMAND_TAIL_CHARS,
  COMMAND_TAIL_LINES,
  commandArgv,
  commandLineOf,
  commandTail,
} from "./argv.js";
import type { ReviewFinding } from "./findings.js";
import { findingsSentinel } from "./parity.js";

// The `lint_check` gate's rules, pure: a repo's configured command in, an argv and
// findings out. The supervisor's job (apps/supervisor/src/jobs/) runs the process; every judgement
// about what may be run and what the answer means is here, where it is table-testable.
//
// WHY A GATE AND NOT A REFUSAL. A builder reaches `request_review` with files that fail the repo's
// lint command and the review round is spent on it. The `build` template asks the builder to lint,
// but prompt text asks and the server decides (§10.3), and a transition-law predicate cannot help:
// laws are pure and read rows, never a subprocess. The other candidate — refusing the pin, as
// `noAttributionTrailers` does — cannot carry this: that check reads `git log` on a bare mirror,
// while linting *executes repo-controlled code*, which belongs in a session with a run class, a
// wall clock, a raw log and a kill switch; and a refusal has no row, so it cannot be waived by an
// operator when an agent genuinely cannot fix it. A gate row can be waived, rerun, retried and
// superseded, and it carries §10.3 evidence. See the design.

/** `findings.category` of everything this gate reports. */
export const LINT_CATEGORY = "lint";

/** The most argv words a lint command may have: a guard against a pasted script, not a real limit. */
export const LINT_ARGV_MAX = ARGV_WORDS_MAX;

/**
 * `repos.lint_cmd` as an argv: whitespace-separated words, no shell. `pnpm -w lint` — this repo's
 * own command — is an argv; `eslint . && prettier --check .` is a `package.json` script, and the
 * refusal says so rather than running half of it.
 *
 * The rule itself is `commandArgv`'s, shared with `workspaces.qa_cmd`; the wording
 * stays here, where it can name this column and this fix.
 */
export const lintArgv = (cmd: string | null | undefined): Result<string[]> =>
  commandArgv(cmd, {
    empty:
      'no lint command: set repos.lint_cmd for this repo (`frm config apply`, e.g. "pnpm -w lint")',
    compound: (text) =>
      `repos.lint_cmd ${JSON.stringify(text)} is not an argv: it is run with no shell, so quoting, redirection, globs and \`&&\` are not available. Put the compound command in a package script and name that script here.`,
    tooLong: (words) =>
      `repos.lint_cmd has ${String(words)} words, over the ${String(LINT_ARGV_MAX)}-word cap: name a package script instead`,
  });

/** An argv as one readable line, for a finding, a log and `GateEvidence.command`. */
export const lintCommandLine = commandLineOf;

/** The most of a failing command's output a finding carries inline (Invariant 9: the rest is a path). */
export const LINT_TAIL_LINES = COMMAND_TAIL_LINES;
export const LINT_TAIL_CHARS = COMMAND_TAIL_CHARS;

/**
 * The end of a command's output, capped both ways: the last lines are where a linter puts its
 * summary, and the whole of it is on disk at the path the finding names. Never the head — a
 * thousand prettier complaints would push the count off the inline copy entirely.
 */
export const lintTail = commandTail;

/** What the job observed of one command it ran. */
export interface LintRun {
  /** The argv, as run. */
  readonly argv: readonly string[];
  /** The process's exit code, or null when it died on a signal or never started. */
  readonly exitCode: number | null;
  /** stdout and stderr, interleaved as the process wrote them. */
  readonly output: string;
  /** Where the whole output was written, for the finding to name (Invariant 9). */
  readonly logPath: string;
}

const blocker = (summary: string, detail: string): ReviewFinding =>
  ({
    severity: "blocker",
    summary,
    file: null,
    line: null,
    category: LINT_CATEGORY,
    detail_md: detail,
  }) satisfies ReviewFinding;

/**
 * The gate's finding for one lint run, or `[]` when the command exited 0.
 *
 * The finding **names the command verbatim** — the ticket's Done-when — because this is what
 * reaches the next builder session: the `fix` template's `findings` section is compiled from these
 * rows, so `pnpm -w lint` arrives as an instruction, not as "lint failed".
 */
export function lintFindings(
  repoId: string,
  run: LintRun,
): readonly ReviewFinding[] {
  if (run.exitCode === 0) return [];
  const command = lintCommandLine(run.argv);
  const how =
    run.exitCode === null
      ? "did not exit normally (killed, or it never started)"
      : `exited ${String(run.exitCode)}`;
  return [
    blocker(
      `\`${command}\` ${how} in repo ${repoId}`,
      [
        `Run \`${command}\` in your worktree, fix what it reports, commit, and request review again.`,
        `Full output: ${run.logPath}`,
        "",
        "```",
        lintTail(run.output),
        "```",
      ].join("\n"),
    ),
  ];
}

/**
 * The job's whole answer, as one `assistant_text` record — the same contract `parityReport` states:
 * `SCRIPT_CAPS.outputSchema` is false, so a script gate takes the heuristic path () and
 * `collect()` refuses the review unless the trailing `FINDINGS: <n>` line declares exactly as many
 * as the embedded `ReviewOutput` carries. Both halves come from this one list, so they agree by
 * construction.
 */
export function lintReport(
  repoId: string,
  findings: readonly ReviewFinding[],
): string {
  const output = {
    summary:
      findings.length === 0
        ? `lint_check: repo ${repoId} is clean.`
        : `lint_check: repo ${repoId} fails its lint command.`,
    findings: [...findings],
  };
  return [
    JSON.stringify(output, null, 2),
    "",
    findingsSentinel(findings.length),
  ].join("\n");
}
