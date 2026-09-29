import {
  CI_REQUIRED_ENTRY_MAX,
  CI_REQUIRED_MAX,
  QA_CI_TIMEOUT_MAX_MS,
  QA_CI_TIMEOUT_MIN_MS,
  QA_MODES,
  QA_REPORT_GLOBS_MAX,
  QA_SECRETS_MAX,
  QA_TIMEOUT_MAX_MS,
  QA_TIMEOUT_MIN_MS,
  ciEntryNamesNoCheck,
  qaArgv,
  qaReportGlob,
  qaSecretName,
} from "@bayon/core";
import { z } from "zod";

// A project's QA harness, as `POST /projects`, `PATCH /projects/:id` and `GET /projects`
// carry it. Every field is checked by core's own rule, not by a second copy of it here: the argv
// rule, the secret-name shape and the glob rule each have one definition, and the GUI runs these
// same schemas so what the form accepts is what the server accepts.
//
// Nothing in this file names a tool, a file or a report format. A project's harness is one command
// that exits non-zero when the project is broken; that is the whole contract.

const checked =
  <T>(check: (value: T) => { ok: boolean; error?: { message: string } }) =>
  (value: T, ctx: z.RefinementCtx): void => {
    const result = check(value);
    if (!result.ok) {
      ctx.addIssue({
        code: "custom",
        message: result.error?.message ?? "refused",
      });
    }
  };

/**
 * `workspaces.qa_mode`: `none`, `command`, `pending` ("Bayon, build me one"), or `ci` (the checks
 * on the ticket's pull request).
 */
export const QaMode = z.enum(QA_MODES);
export type QaMode = z.infer<typeof QaMode>;

/** The harness command: an argv, no shell, with the three placeholders (core `qaArgv`). */
export const QaCommand = z
  .string()
  .trim()
  .max(1_000)
  .superRefine(checked(qaArgv));

/** A host-store secret NAME. The value never comes near the API (§14). */
export const QaSecretName = z
  .string()
  .trim()
  .max(64)
  .superRefine(checked(qaSecretName));

/** A report glob, relative to the worktree (core `qaReportGlob`). */
export const QaReportGlob = z
  .string()
  .trim()
  .max(200)
  .superRefine(checked(qaReportGlob));

/**
 * One required CI check: the name the forge reports it by — required in every repo the
 * ticket delivers — or `<repo_id>:<name>`, required in that repo only (core `ciRequirements`: split
 * on the first colon, and only when the prefix is one of the project's repos). No other shape is
 * assumed; a project's CI names its checks however it likes, colons included. What this schema can
 * refuse without the project's repos is a repo-shaped prefix with no check after it; the writer
 * refuses a prefix that is no repo of the project (core `ciRequiredRefusal`).
 */
export const QaCiCheckName = z
  .string()
  .trim()
  .min(1)
  .max(CI_REQUIRED_ENTRY_MAX)
  .refine(
    (entry) => !ciEntryNamesNoCheck(entry),
    "a required check written as <repo>:<name> needs a name after the colon",
  );

/** How long a `ci` gate waits for its checks: a minute to six hours (core's bounds). */
export const QaCiTimeoutMs = z
  .int()
  .min(QA_CI_TIMEOUT_MIN_MS)
  .max(QA_CI_TIMEOUT_MAX_MS);

export const QaTimeoutMs = z
  .int()
  .min(QA_TIMEOUT_MIN_MS)
  .max(QA_TIMEOUT_MAX_MS);

/**
 * A project's QA settings as an operator sets them. `mode` is the whole switch: `none` turns the
 * gate off (and `pass_harness` is the operator's override with a note, as it always was), `command`
 * runs `cmd`, `pending` files a ticket asking for a harness and leaves the gate off until the
 * operator switches the mode themselves.
 *
 * `mode: "command"` must bring a command — a gate whose command is blank could only ever fail — and
 * that is checked here as well as by 036's CHECK, so the refusal names the field rather than
 * arriving as a constraint violation.
 */
export const QaConfig = z
  .strictObject({
    mode: QaMode,
    cmd: QaCommand.nullable().default(null),
    /** The harness's own wall clock; null is the 20-minute default. */
    timeout_ms: QaTimeoutMs.nullable().default(null),
    secrets: z.array(QaSecretName).max(QA_SECRETS_MAX).default([]),
    reports: z.array(QaReportGlob).max(QA_REPORT_GLOBS_MAX).default([]),
    junit: QaReportGlob.nullable().default(null),
    /** `ci`'s required check names; empty requires every check the pull request reports. */
    ci_checks: z.array(QaCiCheckName).max(CI_REQUIRED_MAX).default([]),
    /** `ci`'s wait for the checks; null is core's hour. */
    ci_timeout_ms: QaCiTimeoutMs.nullable().default(null),
  })
  .refine(
    (qa) => qa.mode !== "command" || (qa.cmd ?? "").trim() !== "",
    "a QA mode of `command` needs a command to run",
  );
export type QaConfig = z.infer<typeof QaConfig>;

/** A stored configuration, as the views serve it. */
export const QaConfigView = z.object({
  mode: QaMode,
  cmd: z.string().nullable(),
  timeout_ms: z.int().nullable(),
  secrets: z.array(z.string()),
  reports: z.array(z.string()),
  junit: z.string().nullable(),
  ci_checks: z.array(z.string()),
  ci_timeout_ms: z.int().nullable(),
});
export type QaConfigView = z.infer<typeof QaConfigView>;

/** The QA harness a project runs nothing with: what a project without one reads as. */
export const NO_QA: QaConfigView = {
  mode: "none",
  cmd: null,
  timeout_ms: null,
  secrets: [],
  reports: [],
  junit: null,
  ci_checks: [],
  ci_timeout_ms: null,
};
