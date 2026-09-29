import { err, ok, type Result } from "../errors.js";
import {
  ARGV_WORDS_MAX,
  SHELL_META_NO_BRACES,
  commandArgv,
  commandLineOf,
  commandTail,
} from "./argv.js";
import type { ReviewFinding } from "./findings.js";
import {
  parseJUnit,
  QA_JUNIT_CASES_MAX,
  type JUnitFailure,
  type JUnitParse,
} from "./junit.js";
import { findingsSentinel } from "./parity.js";

// The `qa_harness` gate's rules (§10.4), pure: a project's configured command in, an
// argv and findings out. The supervisor's job runs the process; every judgement about what may be
// run and what the answer means is here, where it is table-testable.
//
// WHAT BAYON KNOWS ABOUT A PROJECT'S QA. One thing: **a command that exits non-zero when the project
// is broken.** Not a framework, not a file layout, not a report format, not a naming convention. A
// project may hand back a JUnit report and get a finding per failed case; a project that hands back
// nothing gets the command, the exit code and a capped tail, which is the whole contract. Anything
// more specific than that in this file would be one project's habits compiled into a control plane
// meant for any project (Invariant 1's rule, applied to a repository rather than to a runner).

/** `findings.category` of everything this gate reports. */
export const QA_CATEGORY = "qa";

/**
 * `workspaces.qa_mode`. `none`: the project runs no harness, and `pass_harness` is the operator's
 * override with a note, as it always was. `command`: `qa_cmd` runs as this gate. `pending`: the
 * operator has asked Bayon to build one — a ticket is filed, and the mode stays `pending` until the
 * operator switches it, because Bayon cannot know that the work landed. `ci` (043): the
 * gate runs nothing and waits for the checks the forge reports on the ticket's pull request
 * (`ci.ts`).
 */
export const QA_MODES = ["none", "command", "pending", "ci"] as const;
export type QaMode = (typeof QA_MODES)[number];

export const isQaMode = (mode: string): mode is QaMode =>
  (QA_MODES as readonly string[]).includes(mode);

/**
 * `qa_runs.state` (036's CHECK): the harness passed, found a bug, or could not run at all. Named here
 * so a reader (the GUI's status map) is typed from the one list rather than retyping it.
 */
export const QA_RUN_STATES = ["passed", "failed", "error"] as const;
export type QaRunState = (typeof QA_RUN_STATES)[number];

/**
 * A project's QA harness as it is stored and served: `workspaces.qa_*`, with the two JSON columns
 * already parsed. One shape for the writer, the reads, the job and the GUI.
 */
export interface QaConfigFields {
  readonly mode: QaMode;
  /** The argv, as declared; null unless `mode` is `command`. */
  readonly cmd: string | null;
  /** null: `QA_TIMEOUT_DEFAULT_MS`. */
  readonly timeout_ms: number | null;
  /** Host-store secret NAMES, never values (§14). */
  readonly secrets: readonly string[];
  /** Globs, relative to the worktree, whose matches the gate attaches as evidence. */
  readonly reports: readonly string[];
  readonly junit: string | null;
  /**
   * `ci` mode's required check names (043, `qa_ci_checks_json`); empty means every check the forge
   * reports on the pull request's head is required.
   */
  readonly ci_checks: readonly string[];
  /** How long a `ci` gate waits for the checks (`qa_ci_timeout_ms`); null: `QA_CI_TIMEOUT_DEFAULT_MS`. */
  readonly ci_timeout_ms: number | null;
}

/** What a project that runs no harness reads as. */
export const NO_QA_CONFIG: QaConfigFields = {
  mode: "none",
  cmd: null,
  timeout_ms: null,
  secrets: [],
  reports: [],
  junit: null,
  ci_checks: [],
  ci_timeout_ms: null,
};

/** The modes whose project opens a `qa_harness` gate: a command to run, or a CI to wait for. */
export const QA_GATE_MODES: readonly QaMode[] = ["command", "ci"];

/** Whether a project's `qa_harness` gate opens at all: the laws' `qa_configured`. */
export const qaGateOpens = (mode: QaMode): boolean =>
  QA_GATE_MODES.includes(mode);

/** The harness's own wall clock when the project sets none: 20 minutes. */
export const QA_TIMEOUT_DEFAULT_MS = 1_200_000;
/** Bounds on `qa_timeout_ms`: under a few seconds nothing can run; over an hour is the fleet's. */
export const QA_TIMEOUT_MIN_MS = 10_000;
export const QA_TIMEOUT_MAX_MS = 3_600_000;

/** A host-store secret name (§14): the shape every store spells the same. */
export const QA_SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
export const QA_SECRET_NAME_MAX = 64;
/** The most secrets one harness may name. */
export const QA_SECRETS_MAX = 8;

/** The most report globs a project may declare, and the most files they may contribute. */
export const QA_REPORT_GLOBS_MAX = 8;
export const QA_REPORTS_MAX = 20;
/** A single report past this is left where it is: the log already says the harness ran. */
export const QA_REPORT_BYTES_MAX = 5 * 1024 * 1024;
export const QA_GLOB_MAX = 200;

/** The most of one command's output the job holds in memory; past it the process is killed. */
export const QA_OUTPUT_MAX = 1_000_000;

/**
 * The placeholders a QA command may spend, substituted per word by the job. A harness usually has to
 * be told *what* it is testing, and these are the three facts Bayon has that a project could want:
 * its own ticket key, the key of whatever filed the ticket (`tickets.origin_ref`, empty when there
 * is none), and the branch the work is on (empty when there is none).
 */
export const QA_PLACEHOLDERS = ["ticket", "external_key", "branch"] as const;
export type QaPlaceholder = (typeof QA_PLACEHOLDERS)[number];
export type QaValues = Readonly<Record<QaPlaceholder, string>>;

const PLACEHOLDER = /\{([^{}]*)\}/g;

const isPlaceholder = (name: string): name is QaPlaceholder =>
  (QA_PLACEHOLDERS as readonly string[]).includes(name);

const named = QA_PLACEHOLDERS.map((p) => `{${p}}`).join(", ");

/**
 * `workspaces.qa_cmd` as an argv: whitespace-separated words, no shell, the same rule
 * `repos.lint_cmd` is held to — with the braces the placeholders spend accounted for by hand.
 *
 * The brace check is not decoration. `{` and `}` are shell metacharacters, and dropping them from
 * the refused set to make `{ticket}` expressible would let `{a,b}` through as well. So: the rest of
 * the metacharacters are refused as ever; every `{…}` group must name one of the three placeholders;
 * and any brace left over after those is refused. A typo (`{tickt}`) is refused here rather than
 * handed to the harness as a literal argument, where it would look like a broken test suite.
 */
export function qaArgv(cmd: string | null | undefined): Result<string[]> {
  const argv = commandArgv(cmd, {
    meta: SHELL_META_NO_BRACES,
    empty:
      'no QA command: set the project\'s QA command in its Settings view (e.g. "make check")',
    compound: (text) =>
      `the QA command ${JSON.stringify(text)} is not an argv: it is run with no shell, so quoting, redirection, globs and \`&&\` are not available. Put the compound command in a script in the repository and name that script here.`,
    tooLong: (words) =>
      `the QA command has ${String(words)} words, over the ${String(ARGV_WORDS_MAX)}-word cap: name a script in the repository instead`,
  });
  if (!argv.ok) return argv;
  const text = argv.value.join(" ");
  // `m[0]` is the whole `{name}`, so the name is what the braces enclose. Not `m[1]`: a capture
  // group types as `string | undefined` even when the pattern always fills it, and the fallback
  // that satisfies the type is a branch no test can reach.
  const unknown = [...text.matchAll(PLACEHOLDER)]
    .map((m) => m[0].slice(1, -1))
    .filter((name) => !isPlaceholder(name));
  if (unknown.length > 0) {
    return err({
      class: "validation",
      message: `the QA command names no such placeholder: ${unknown.map((n) => `{${n}}`).join(", ")}. The ones it may use are ${named}.`,
      retryable: false,
    });
  }
  if (/[{}]/.test(text.replace(PLACEHOLDER, ""))) {
    return err({
      class: "validation",
      message: `the QA command has an unmatched brace: it is run with no shell, so a brace means nothing but a placeholder (${named}).`,
      retryable: false,
    });
  }
  return ok(argv.value);
}

/**
 * The argv with its placeholders filled, per word. A value is never re-split: `--grep={ticket}`
 * stays one argument whatever the ticket's key is, because there is no shell to split it — which is
 * the point of running argv in the first place.
 */
export const qaSubstitute = (
  argv: readonly string[],
  values: QaValues,
): string[] =>
  argv.map((word) =>
    word.replace(PLACEHOLDER, (whole, name: string) =>
      isPlaceholder(name) ? values[name] : whole,
    ),
  );

/** The harness's wall clock: the project's, held to the bounds, or the default. */
export const qaTimeoutOf = (ms: number | null | undefined): number =>
  ms === null || ms === undefined
    ? QA_TIMEOUT_DEFAULT_MS
    : Math.min(QA_TIMEOUT_MAX_MS, Math.max(QA_TIMEOUT_MIN_MS, ms));

/**
 * Names the supervisor **sets** for every job, or reserves around it, so a secret of that name
 * would be silently thrown away: `envFloor` (jobs/job-env.ts) is applied last, on purpose, and the
 * git environment floor with it. An operator who names one has asked for something that cannot
 * happen, and hearing nothing is worse than hearing no — the harness would run with foreman's value
 * and the failure would look like a broken credential.
 *
 * Stated as a shape rather than as the floor's own list, for two reasons. Core may not import the
 * supervisor or `@bayon/executors`; and the git flag names belong to one file by repo rule
 * (`git-flags.test.ts`), which restating them here would break. A shape is also the safer side of
 * the trade: it refuses a little more than the floor sets, and everything it refuses is a name
 * foreman may take at any time. `job-env.test.ts` holds the real floor against it.
 *
 * `GIT_*` as a whole is reserved: git's environment is foreman's to control (§9.8's floor), and a
 * harness that needs a git credential should read it under a name of its own.
 */
const RESERVED_EXACT: readonly string[] = ["HOME", "TMPDIR"];
const RESERVED_PREFIX: readonly string[] = ["XDG_", "GIT_"];

export const isReservedEnvName = (name: string): boolean =>
  RESERVED_EXACT.includes(name) ||
  RESERVED_PREFIX.some((prefix) => name.startsWith(prefix));

/** A secret name, checked; the value never passes through here. */
export function qaSecretName(name: string): Result<string> {
  const trimmed = name.trim();
  if (trimmed.length > QA_SECRET_NAME_MAX || !QA_SECRET_NAME.test(trimmed)) {
    return err({
      class: "validation",
      message: `${JSON.stringify(name)} is not a secret name: use upper-case letters, digits and underscores, starting with a letter`,
      retryable: false,
    });
  }
  if (isReservedEnvName(trimmed)) {
    return err({
      class: "validation",
      message: `${trimmed} is set by foreman for every job and cannot be a QA secret: the harness would run with foreman's value and never see yours. Give the secret another name and have the harness read that.`,
      retryable: false,
    });
  }
  return ok(trimmed);
}

/**
 * A report glob, checked: relative, forward slashes, no `..` segment. The job matches it against the
 * worktree and copies what it finds into the gate's artifacts, so a pattern that could climb out of
 * the worktree would attach the fleet's own files to a gate.
 */
export function qaReportGlob(pattern: string): Result<string> {
  const text = pattern.trim();
  const problem =
    text === ""
      ? "a report glob is not empty"
      : text.length > QA_GLOB_MAX
        ? `a report glob is at most ${String(QA_GLOB_MAX)} characters`
        : text.startsWith("/")
          ? "a report glob is relative to the worktree, so it does not start with /"
          : text.includes("\\")
            ? "a report glob uses forward slashes"
            : text.split("/").includes("..")
              ? "a report glob does not leave the worktree (`..`)"
              : null;
  return problem === null
    ? ok(text)
    : err({
        class: "validation",
        message: `${JSON.stringify(pattern)}: ${problem}`,
        retryable: false,
      });
}

const escapeRe = (text: string): string =>
  text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `path` (relative, forward slashes) matches `pattern`. `**` is any run of segments, `*` is
 * anything inside one segment, `?` is one character inside one. Small on purpose: a glob library
 * would bring brace expansion and negation, neither of which a report pattern needs, and both of
 * which would have to be re-checked against the escape rule above.
 */
export function matchGlob(pattern: string, path: string): boolean {
  // A placeholder for `**` while the other segments are escaped. It cannot appear in an escaped
  // segment (escapeRe leaves no `<`, and `*` and `?` are replaced), so it is unambiguous.
  const ANY = "<globstar>";
  const source = pattern
    .split("/")
    .map((segment) =>
      segment === "**"
        ? ANY
        : escapeRe(segment).replaceAll("*", "[^/]*").replaceAll("?", "[^/]"),
    )
    .join("/")
    // `a/**/b` matches `a/b` as well as `a/x/y/b`; a leading or trailing `**` eats its own slash.
    .replaceAll(`${ANY}/`, "(?:.*/)?")
    .replaceAll(`/${ANY}`, "(?:/.*)?")
    .replaceAll(ANY, ".*");
  return new RegExp(`^${source}$`).test(path);
}

/** A resolved secret as the job holds it: its name, and its value, which never leaves the env. */
export type QaSecret = readonly [string, string];

/**
 * Every occurrence of a resolved secret replaced by its name. **The one scrub**: every place a
 * harness's bytes can reach a stored row, an artifact or a prompt goes through this function, so
 * there is a single place to strengthen rather than three that can drift.
 *
 * Those places are the harness's stdout and stderr (the log on disk and the finding's tail), the
 * contents of every report file copied into the gate's artifacts, and the JUnit report — scrubbed
 * once as raw text before it is parsed, and again field by field afterwards, because a parse
 * reshapes text and an entity-decoded value is not the bytes that went in.
 *
 * A backstop, not the control: the control is that a secret goes into the child's env and nowhere
 * else (§14, Invariant 11). Short values are left alone — redacting every "1" in a harness's output
 * would destroy the tail and protect nothing.
 */
export const QA_SCRUB_MIN = 4;

/**
 * What a redacted value reads as. Deliberately free of `<`, `>`, `&` and quotes: the scrub runs over
 * a JUnit report *before* it is parsed, and a marker carrying an angle bracket would end a tag early
 * and turn a named failing case into an unnamed one — the redaction corrupting the very report it
 * was protecting. Brackets mean nothing to XML, to a shell or to Markdown.
 */
export const redacted = (name: string): string => `[redacted:${name}]`;

export function scrubSecrets(
  text: string,
  secrets: readonly (readonly [string, string])[],
): string {
  let scrubbed = text;
  for (const [name, value] of secrets) {
    if (value.length < QA_SCRUB_MIN) continue;
    scrubbed = scrubbed.replaceAll(value, redacted(name));
  }
  return scrubbed;
}

/** How much of a file decides whether it is text: enough for any magic number and any header. */
export const QA_TEXT_SNIFF_BYTES = 8192;

/**
 * `bytes` as text the scrub can work on, or null when it is not text at all.
 *
 * A report is whatever a project's tooling writes: XML, JSON, a coverage database, a screenshot.
 * Text can be scrubbed and must be; bytes cannot be, and mangling them would corrupt an artifact an
 * operator may need. The caller copies those unchanged and **says so in the evidence**, so nobody
 * reads a flagged file believing it was cleaned.
 *
 * Text means: no NUL in the first `QA_TEXT_SNIFF_BYTES` (the usual binary tell, and the cheap half),
 * and the whole of it decodes as UTF-8 (the exact half — a replacement character would silently
 * change bytes the scrub then failed to match).
 */
export function scrubbableText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, QA_TEXT_SNIFF_BYTES);
  if (head.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null; // not UTF-8: bytes, not text
  }
}

/**
 * Exit codes that mean the harness never ran, by the conventions every runner shares: 127 "command
 * not found", 126 "found, not executable", 125 "the runner itself could not start" (a container
 * runtime with no device, no image or no daemon). A harness that ran and found a bug does not use
 * them, so treating them as the code's failure would staff a fixer against a bug that does not exist.
 */
export const QA_UNRUNNABLE_EXITS: readonly number[] = [125, 126, 127];

/** What the job observed of the harness it ran. */
export interface QaRun {
  /** The argv, as run, placeholders filled. */
  readonly argv: readonly string[];
  /** The process's exit code, or null when it died on a signal or never started. */
  readonly exitCode: number | null;
  /** stdout and stderr, interleaved as written, already scrubbed. */
  readonly output: string;
  /** Where the whole output was written, for the finding to name (Invariant 9). */
  readonly logPath: string;
  /** The JUnit report's failed cases, when the project named one and it could be read. */
  readonly junit?: JUnitParse;
}

/**
 * What the run means. `reviewer_error` is the one that earns its place: nothing judged the code, so
 * `isCodeFailure` keeps it off the fix path and the operator sees a stuck gate instead
 * of a fixer staffed against nothing.
 */
export type QaOutcome =
  | { readonly state: "passed" }
  | { readonly state: "failed"; readonly findings: readonly ReviewFinding[] }
  | { readonly state: "reviewer_error"; readonly message: string };

const blocker = (summary: string, detail: string): ReviewFinding =>
  ({
    severity: "blocker",
    summary,
    file: null,
    line: null,
    category: QA_CATEGORY,
    detail_md: detail,
  }) satisfies ReviewFinding;

const caseLine = (f: JUnitFailure): string =>
  [f.suite === null ? "" : `${f.suite} › `, f.name].join("");

const caseFinding = (f: JUnitFailure): ReviewFinding => ({
  severity: "blocker",
  summary: `QA case ${f.kind === "error" ? "errored" : "failed"}: ${caseLine(f)}`,
  file: null,
  line: null,
  category: QA_CATEGORY,
  detail_md: f.message ?? "The report gave no message for this case.",
});

/**
 * The gate's verdict for one harness run.
 *
 * The finding **names the command verbatim**, because this is what reaches the next session: the
 * `fix` template's findings section is compiled from these rows, so the project's own command
 * arrives as an instruction rather than as "QA failed".
 */
export function qaVerdict(run: QaRun): QaOutcome {
  const command = commandLineOf(run.argv);
  if (run.exitCode === 0) return { state: "passed" };
  if (run.exitCode === null) {
    return {
      state: "reviewer_error",
      message: `the QA command \`${command}\` did not exit normally (it never started, or it was killed): nothing ran, so the gate decides nothing about this change. Full output: ${run.logPath}`,
    };
  }
  if (QA_UNRUNNABLE_EXITS.includes(run.exitCode)) {
    return {
      state: "reviewer_error",
      message: `the QA command \`${command}\` exited ${String(run.exitCode)}, which means it could not be run at all (a missing command, a missing device or a missing environment variable), not that the change is wrong. Full output: ${run.logPath}`,
    };
  }
  const junit = run.junit;
  const cases =
    junit === undefined || junit.malformed
      ? []
      : junit.failures.map(caseFinding);
  const more =
    junit === undefined ? 0 : Math.max(0, junit.total - junit.failures.length);
  return {
    state: "failed",
    findings: [
      blocker(
        `\`${command}\` exited ${String(run.exitCode)}`,
        [
          `Run \`${command}\` in your worktree, fix what it reports, commit, and request review again.`,
          ...(junit === undefined
            ? []
            : junit.malformed
              ? [
                  "The JUnit report could not be read, so only the exit code is known.",
                ]
              : [
                  `${String(junit.total)} of ${String(junit.cases)} case(s) failed${more > 0 ? `; the first ${String(QA_JUNIT_CASES_MAX)} are listed separately` : ""}.`,
                ]),
          `Full output: ${run.logPath}`,
          "",
          "```",
          commandTail(run.output),
          "```",
        ].join("\n"),
      ),
      ...cases,
    ],
  };
}

/**
 * A JUnit report read for its failed cases, scrubbed on both sides of the parse.
 *
 * Both halves earn their place. The raw scrub catches a secret however the report spells it; the
 * field scrub catches what the parse *made*: `unescapeXml` turns `&#65;` into `A`, so a value the
 * raw text never contained can exist in a `message` by the time it becomes a finding — and a
 * finding's `detail_md` is compiled into the next fix session's prompt (§8.2).
 */
export function qaJunit(
  xml: string,
  secrets: readonly QaSecret[] = [],
): JUnitParse {
  const parsed = parseJUnit(scrubSecrets(xml, secrets));
  if (secrets.length === 0) return parsed;
  const clean = (text: string): string => scrubSecrets(text, secrets);
  return {
    ...parsed,
    failures: parsed.failures.map((f) => ({
      ...f,
      suite: f.suite === null ? null : clean(f.suite),
      name: clean(f.name),
      message: f.message === null ? null : clean(f.message),
    })),
  };
}

/**
 * The job's whole answer, as one `assistant_text` record — the contract `lintReport` and
 * `parityReport` state: `SCRIPT_CAPS.outputSchema` is false, so a script gate takes the heuristic
 * path and `collect()` refuses the review unless the trailing `FINDINGS: <n>` line declares exactly
 * as many as the embedded `ReviewOutput` carries.
 */
export function qaReport(
  project: string,
  findings: readonly ReviewFinding[],
): string {
  const output = {
    summary:
      findings.length === 0
        ? `qa_harness: project ${project} passes its QA command.`
        : `qa_harness: project ${project} fails its QA command.`,
    findings: [...findings],
  };
  return [
    JSON.stringify(output, null, 2),
    "",
    findingsSentinel(findings.length),
  ].join("\n");
}
