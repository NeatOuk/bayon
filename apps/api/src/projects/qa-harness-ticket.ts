import {
  QA_PLACEHOLDERS,
  TEMPLATES,
  complexityColumns,
  compile,
  ok,
  type QaConfigFields,
  type Result,
} from "@bayon/core";
import type { Db } from "@bayon/db";
import type { NewTicket } from "@bayon/db/api";
import type { QaConfigView } from "@bayon/proto";
import { loadTicketSettings } from "../tickets/ticket-settings.js";

// "Bayon, build me one": picking QA mode `pending` for a project files one ticket in it
// asking for a QA harness. The ticket's body is **compiled from the versioned `qa_harness_request`
// template** (Invariant 8), because it becomes a builder's prompt the moment the ticket is staffed —
// string-concatenating it at this call site would let its wording change with no version bump, no
// hash change and no record of either.
//
// The template names no framework, no file and no report format: the agent is asked to find what
// the project already uses. Nothing here is allowed to be more specific than that, which is why the
// only input this call site supplies is the project's name.

const TITLE = "Build a QA harness for this project";

/** The ticket's origin: an operator asked for it through a GUI door (§10.2's set). */
export const QA_HARNESS_ORIGIN = "operator";

/** A stored QA configuration as the API serves it (readonly arrays widened for the DTO). */
export const qaView = (qa: QaConfigFields): QaConfigView => ({
  mode: qa.mode,
  cmd: qa.cmd,
  timeout_ms: qa.timeout_ms,
  secrets: [...qa.secrets],
  reports: [...qa.reports],
  junit: qa.junit,
  ci_checks: [...qa.ci_checks],
  ci_timeout_ms: qa.ci_timeout_ms,
});

/**
 * The harness ticket's columns for a project, compiled but **not written**: `setProjectSettings`
 * inserts them in the same transaction as the mode that asked for them, so a failure to file leaves
 * no project stranded in `pending` with no ticket (the review's MEDIUM).
 *
 * The body is the compiled template; the acceptance criteria restate the contract, so a reviewer
 * has something to hold the work to. A compile failure is an error, not a plainer ticket: a prompt
 * that was not compiled is precisely the bug Invariant 8 exists to stop.
 */
export async function qaHarnessTicket(
  db: Db,
  projectName: string,
): Promise<Result<NewTicket>> {
  const prompt = compile(TEMPLATES.qa_harness_request, {
    project: projectName,
    placeholders: { names: QA_PLACEHOLDERS.map((p) => `{${p}}`).join(", ") },
  });
  if (!prompt.ok) return prompt;
  const settings = await loadTicketSettings(db);
  if (!settings.ok) return settings;
  // Scored as `POST /tickets` scores one, from an empty fact set: nobody has looked at the project
  // yet, so the rubric's own default is the honest answer.
  const complexity = await complexityColumns(
    {},
    settings.value["complexity.rubric"],
  );
  if (!complexity.ok) return complexity;
  return ok({
    title: TITLE,
    type: "chore" as const,
    status: "backlog",
    origin: QA_HARNESS_ORIGIN,
    body_md: prompt.value.text,
    acceptance_md: [
      "- One command, runnable as an argv with no shell, that exits 0 when the project is good and non-zero when it is not.",
      "- It runs from the repository root on a fresh checkout, with no interactive prompt.",
      "- It uses the project's own tooling: no test framework or task runner the project has not already chosen.",
      "- The hand-off names the command, any report globs, any secret names it needs, and how long a cold run takes.",
    ].join("\n"),
    ...complexity.value,
  });
}
