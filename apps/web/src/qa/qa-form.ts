import {
  CI_REQUIRED_MAX,
  QA_CI_NEEDS_PR,
  ciRequiredRefusal,
  qaCiRefusal,
} from "@bayon/core";
import {
  QaCiCheckName,
  QaCiTimeoutMs,
  QaCommand,
  QaConfig,
  QaReportGlob,
  QaSecretName,
  QaTimeoutMs,
  type DeliveryConfigView,
  type QaConfigView,
  type QaMode,
} from "@bayon/proto";

// The QA harness form's state, shared by the project's Settings view and the New project form. Every
// field is checked with the **proto schema the server uses** (which is core's rule underneath), so
// what the form accepts is what the server accepts and a refusal never arrives as a surprise 400.
//
// Nothing here knows what a project's harness is: the placeholders are the only thing Bayon offers,
// and the command, the globs and the secret names are whatever the project needs.

/** The lists are typed as lines so an operator edits them as text, one per line. */
export interface QaDraft {
  readonly mode: QaMode;
  readonly cmd: string;
  /** Minutes, as typed; blank is the default. */
  readonly timeout: string;
  /** One secret name per line. */
  readonly secrets: string;
  /** One glob per line. */
  readonly reports: string;
  readonly junit: string;
  /** `ci` mode's required check names: one per line, or comma-separated. */
  readonly ciChecks: string;
  /** `ci` mode's wait in minutes, as typed; blank is the default hour. */
  readonly ciTimeout: string;
}

export const BLANK_QA: QaDraft = {
  mode: "none",
  cmd: "",
  timeout: "",
  secrets: "",
  reports: "",
  junit: "",
  ciChecks: "",
  ciTimeout: "",
};

const MINUTE = 60_000;

/** A stored configuration, to edit. */
export const qaDraftOf = (qa: QaConfigView): QaDraft => ({
  mode: qa.mode,
  cmd: qa.cmd ?? "",
  timeout:
    qa.timeout_ms === null ? "" : String(Math.round(qa.timeout_ms / MINUTE)),
  secrets: qa.secrets.join("\n"),
  reports: qa.reports.join("\n"),
  junit: qa.junit ?? "",
  ciChecks: qa.ci_checks.join("\n"),
  ciTimeout:
    qa.ci_timeout_ms === null
      ? ""
      : String(Math.round(qa.ci_timeout_ms / MINUTE)),
});

/**
 * Check names, one per line or comma-separated, trimmed, blanks and repeats dropped. A check name
 * may hold a comma only if the operator puts each name on its own line.
 */
export const checkNamesOf = (text: string): string[] => {
  const lines = linesOf(text);
  const names = lines.length > 1 ? lines : lines.flatMap((l) => l.split(","));
  return [...new Set(names.map((n) => n.trim()).filter((n) => n !== ""))];
};

/** Lines, trimmed, blanks dropped: how the three list fields are read. */
export const linesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

export interface QaProblems {
  readonly cmd?: string;
  readonly timeout?: string;
  readonly secrets?: string;
  readonly reports?: string;
  readonly junit?: string;
  /** `ci` mode refused beside this delivery (core `QA_CI_NEEDS_PR`). */
  readonly mode?: string;
  readonly ciChecks?: string;
  readonly ciTimeout?: string;
}

export interface QaCheck {
  /** What to send, or null while a field is missing or refused. */
  readonly config: QaConfig | null;
  /** A problem per field typed but refused; an empty field is missing, not refused. */
  readonly problems: QaProblems;
}

export const CMD_MISSING = "A QA mode of “run a command” needs a command.";
export const TIMEOUT_PROBLEM = "Whole minutes, from 1 to 60.";
export const CI_TIMEOUT_PROBLEM = "Whole minutes, from 1 to 360.";
export const CI_CHECKS_PROBLEM = `At most ${String(CI_REQUIRED_MAX)} check names, each at most 200 characters, and a <repo>: prefix needs a name after it.`;
export { QA_CI_NEEDS_PR };

/** The first of `values` the schema refuses, said in the form's own words; none passes as undefined. */
function firstProblem(
  values: readonly string[],
  check: (value: string) => boolean,
  say: (value: string) => string,
): string | undefined {
  const bad = values.find((value) => !check(value));
  return bad === undefined ? undefined : say(bad);
}

/**
 * `ci` mode's two fields, checked with the server's schemas, and its refusal beside the
 * project's delivery when the caller knows it.
 */
function ciProblems(
  draft: QaDraft,
  delivery: Pick<DeliveryConfigView, "mode" | "when"> | undefined,
  repoIds: readonly string[] | undefined,
): {
  readonly problems: QaProblems;
  readonly checks: string[];
  readonly timeout: number | null;
} {
  const checks = checkNamesOf(draft.ciChecks);
  const minutes = draft.ciTimeout.trim();
  const timeout =
    minutes === "" ? null : QaCiTimeoutMs.safeParse(Number(minutes) * MINUTE);
  const namesOk =
    checks.length <= CI_REQUIRED_MAX &&
    checks.every((c) => QaCiCheckName.safeParse(c).success);
  const refused =
    delivery === undefined ? null : qaCiRefusal(draft.mode, delivery);
  // A `<repo>:` prefix that is no repo of the project: the server's own sentence, before a save.
  const badPrefix =
    repoIds === undefined ? null : ciRequiredRefusal(checks, repoIds);
  return {
    problems: {
      ...(refused === null ? {} : { mode: refused }),
      ...(draft.mode === "ci" && !namesOk
        ? { ciChecks: CI_CHECKS_PROBLEM }
        : draft.mode === "ci" && badPrefix !== null
          ? { ciChecks: badPrefix }
          : {}),
      ...(draft.mode === "ci" && timeout !== null && !timeout.success
        ? { ciTimeout: CI_TIMEOUT_PROBLEM }
        : {}),
    },
    checks,
    timeout: timeout === null ? null : (timeout.data ?? null),
  };
}

/**
 * The draft checked field by field, and the configuration it sends when every field passes. With
 * the project's `delivery`, `ci` mode is refused beside one that opens no pull request at review;
 * with its `repoIds`, a required check's `<repo>:` prefix must name one of them.
 */
export function checkQa(
  draft: QaDraft,
  delivery?: Pick<DeliveryConfigView, "mode" | "when">,
  repoIds?: readonly string[],
): QaCheck {
  const ci = ciProblems(draft, delivery, repoIds);
  const cmd = draft.cmd.trim();
  const command = cmd === "" ? null : QaCommand.safeParse(cmd);
  const minutes = draft.timeout.trim();
  const timeout =
    minutes === "" ? null : QaTimeoutMs.safeParse(Number(minutes) * MINUTE);
  const secrets = linesOf(draft.secrets);
  const reports = linesOf(draft.reports);
  const junitText = draft.junit.trim();
  const junit = junitText === "" ? null : QaReportGlob.safeParse(junitText);
  const badSecret = firstProblem(
    secrets,
    (v) => QaSecretName.safeParse(v).success,
    (v) => `${v}: upper-case letters, digits and underscores, a letter first.`,
  );
  const badGlob = firstProblem(
    reports,
    (v) => QaReportGlob.safeParse(v).success,
    (v) => `${v}: a path inside the worktree, like reports/*.xml.`,
  );
  const problems: QaProblems = {
    ...(command !== null && !command.success
      ? { cmd: message(command.error) }
      : draft.mode === "command" && cmd === ""
        ? { cmd: CMD_MISSING }
        : {}),
    ...(timeout !== null && !timeout.success
      ? { timeout: TIMEOUT_PROBLEM }
      : {}),
    ...(badSecret === undefined ? {} : { secrets: badSecret }),
    ...(badGlob === undefined ? {} : { reports: badGlob }),
    ...(junit !== null && !junit.success
      ? { junit: "A path inside the worktree, like reports/junit.xml." }
      : {}),
    ...ci.problems,
  };
  if (Object.keys(problems).length > 0) return { config: null, problems };
  const parsed = QaConfig.safeParse({
    mode: draft.mode,
    // Only `command` keeps a command: turning the harness off leaves nothing behind to re-run.
    cmd: draft.mode === "command" ? (command?.data ?? null) : null,
    timeout_ms: timeout === null ? null : (timeout.data ?? null),
    secrets,
    reports,
    junit: junit === null ? null : (junit.data ?? null),
    // Only `ci` keeps its checks and wait, as only `command` keeps its command.
    ci_checks: draft.mode === "ci" ? ci.checks : [],
    ci_timeout_ms: draft.mode === "ci" ? ci.timeout : null,
  });
  return {
    config: parsed.success ? parsed.data : null,
    problems: parsed.success ? {} : { cmd: CMD_MISSING },
  };
}

/** The first line of a zod refusal: the rule's own words, which core wrote. */
function message(error: unknown): string {
  const issues =
    typeof error === "object" && error !== null && "issues" in error
      ? (error as { issues: readonly { message?: string }[] }).issues
      : [];
  return issues[0]?.message ?? "This command was refused.";
}
