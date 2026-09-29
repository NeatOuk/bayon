import { Field } from "@/components/field";
import { Switch } from "@/components/ui/switch";
import { DocsFields } from "@/docs/docs-fields";
import { checkDocs, type DocsDraft, type JiraDefaults } from "@/docs/docs-form";

// New project's optional Docs section. Off by default: a project without one works
// exactly as it always has, with its agents reading the ticket alone. Everything it configures can
// be set later in the project's Settings view; this is here so an operator who is already mirroring
// from Jira can turn the docs on in the same breath.

export const DOCS_CREATE_LABEL = "Let agents read this project's docs";

/** Off by default. On, the kind and (for a real source) the site, the account and the spaces. */
export function DocsCreateSection({
  on,
  draft,
  jira,
  onToggle,
  onChange,
}: {
  readonly on: boolean;
  readonly draft: DocsDraft;
  /** What "same as Jira" would copy: the form's own Jira source, or null while it has none. */
  readonly jira: JiraDefaults | null;
  readonly onToggle: (on: boolean) => void;
  readonly onChange: (draft: DocsDraft) => void;
}) {
  const incomplete = on && checkDocs(draft, jira).source === null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <Field
        label={DOCS_CREATE_LABEL}
        layout="inline"
        hint={
          <>
            Two read-only tools, so an agent can open the pages a ticket links
            to instead of working from its summary. You can set this up later in
            the project&apos;s Settings.
          </>
        }
      >
        {({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            checked={on}
            onCheckedChange={(next: boolean) => onToggle(next)}
          />
        )}
      </Field>
      {on && (
        <>
          <DocsFields draft={draft} jira={jira} onChange={onChange} />
          {incomplete && (
            <p className="text-sm text-muted-foreground">
              Complete the documentation source, or turn this off.
            </p>
          )}
        </>
      )}
    </div>
  );
}
