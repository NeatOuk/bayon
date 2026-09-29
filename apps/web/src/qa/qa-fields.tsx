import { Field } from "@/components/field";
import { RadioChoices } from "@/components/radio-choices";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { checkQa, type QaDraft } from "@/qa/qa-form";
import type { DeliveryConfigView, QaMode } from "@bayon/proto";

// The QA harness's fields — the mode, and for `command` the command, its clock, its secrets, its
// report globs and its JUnit report — shared by the New project form and the project's Settings
// view, so both take and refuse exactly the same (checkQa runs the server's own schemas).
//
// The wording is deliberately toolchain-free. Bayon asks a project for **a command that exits
// non-zero when the project is broken**, and the placeholders are the only thing it offers back.

export const QA_SECTION_LABEL = "QA harness";

export const QA_MODE_LABELS: Readonly<Record<QaMode, string>> = {
  none: "No harness",
  command: "Run a command",
  pending: "Bayon builds one",
  ci: "CI checks on the pull request",
};

export const QA_MODE_HINTS: Readonly<Record<QaMode, string>> = {
  none: "Nothing runs. You pass QA yourself, with a note saying why.",
  command:
    "One command, run on the reviewed commit. It passes when it exits 0.",
  pending:
    "Files a ticket in this project asking an agent to build one. Nothing runs until you switch this to “Run a command”.",
  ci: "Nothing runs here: QA waits for the checks your CI reports on the pull request Bayon opens, and passes when they pass.",
};

const MODES: readonly QaMode[] = ["none", "command", "pending", "ci"];

/** The one line a project with several repos gets on the required checks field. */
export const perRepoHint = (repoIds: readonly string[]): string =>
  `A name is required in every repo; write repo:name to require it in one repo only (${repoIds.join(", ")}).`;

export function QaFields({
  draft,
  onChange,
  delivery,
  repoIds,
}: {
  readonly draft: QaDraft;
  readonly onChange: (draft: QaDraft) => void;
  /**
   * The project's delivery, when known: CI checks need a pull request opened as review passes, and
   * the refusal is shown here, before a save, in the server's own sentence.
   */
  readonly delivery?: Pick<DeliveryConfigView, "mode" | "when">;
  /** The project's repos, when known: what a `repo:name` entry may name, and the hint's list. */
  readonly repoIds?: readonly string[];
}) {
  const { problems } = checkQa(draft, delivery, repoIds);
  return (
    <div className="flex flex-col gap-3">
      <RadioChoices
        legend="How QA is decided"
        values={MODES}
        labels={QA_MODE_LABELS}
        hints={QA_MODE_HINTS}
        value={draft.mode}
        onChange={(mode) => onChange({ ...draft, mode })}
      />
      {draft.mode === "ci" && (
        <>
          {problems.mode !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {problems.mode}
            </p>
          )}
          <Field
            label="Required checks"
            hint={
              <>
                Optional. One check name per line, or separated by commas,
                exactly as your CI names them. Blank: every check each pull
                request reports must pass.
                {repoIds !== undefined && repoIds.length > 1 && (
                  <span className="block">{perRepoHint(repoIds)}</span>
                )}
              </>
            }
            error={problems.ciChecks}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={3}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                spellCheck={false}
                className="font-mono text-xs [font-variant-ligatures:none]"
                placeholder="build"
                value={draft.ciChecks}
                onChange={(event) =>
                  onChange({ ...draft, ciChecks: event.target.value })
                }
              />
            )}
          </Field>
          <Field
            label="Wait for CI (minutes)"
            hint="Blank is 60 minutes. Past it, QA stops waiting and asks you: it never counts as the change failing."
            error={problems.ciTimeout}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="60"
                value={draft.ciTimeout}
                onChange={(event) =>
                  onChange({ ...draft, ciTimeout: event.target.value })
                }
              />
            )}
          </Field>
        </>
      )}
      {draft.mode === "command" && (
        <>
          <Field
            label="Command"
            hint="Run as arguments, with no shell — no pipes, no && and no redirection. It may use {ticket}, {external_key} and {branch}."
            error={problems.cmd}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                spellCheck={false}
                className="font-mono [font-variant-ligatures:none]"
                placeholder="make check"
                value={draft.cmd}
                onChange={(event) =>
                  onChange({ ...draft, cmd: event.target.value })
                }
              />
            )}
          </Field>
          <Field
            label="Time limit (minutes)"
            hint="Blank is 20 minutes. Past it the harness is stopped and the gate decides nothing."
            error={problems.timeout}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="20"
                value={draft.timeout}
                onChange={(event) =>
                  onChange({ ...draft, timeout: event.target.value })
                }
              />
            )}
          </Field>
          <Field
            label="Secrets"
            hint="One name per line, from the host secret store. Names only — a value is never stored here, and never appears in the output."
            error={problems.secrets}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={2}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                spellCheck={false}
                className="font-mono text-xs [font-variant-ligatures:none]"
                value={draft.secrets}
                onChange={(event) =>
                  onChange({ ...draft, secrets: event.target.value })
                }
              />
            )}
          </Field>
          <Field
            label="Reports"
            hint="One glob per line, relative to the repository. What they match is kept with the gate."
            error={problems.reports}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={2}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                spellCheck={false}
                className="font-mono text-xs [font-variant-ligatures:none]"
                placeholder="reports/*.xml"
                value={draft.reports}
                onChange={(event) =>
                  onChange({ ...draft, reports: event.target.value })
                }
              />
            )}
          </Field>
          <Field
            label="JUnit report"
            hint="Optional. If your tooling writes one, each failed case becomes its own finding."
            error={problems.junit}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                spellCheck={false}
                className="font-mono text-xs [font-variant-ligatures:none]"
                placeholder="reports/junit.xml"
                value={draft.junit}
                onChange={(event) =>
                  onChange({ ...draft, junit: event.target.value })
                }
              />
            )}
          </Field>
        </>
      )}
    </div>
  );
}
