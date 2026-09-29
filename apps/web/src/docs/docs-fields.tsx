import { Field } from "@/components/field";
import { RadioChoices } from "@/components/radio-choices";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { checkDocs, type DocsDraft, type JiraDefaults } from "@/docs/docs-form";
import type { DocsKind } from "@bayon/proto";

// The documentation source's fields — the kind, the site and account (or "same as Jira") and the
// spaces an agent may read — shared by the New project form and the project's Settings view, so
// both take and refuse exactly the same (checkDocs runs the server's own schemas).
//
// No site, space or page name appears here: a project says where its documentation lives, and the
// placeholders are shapes.

export const DOCS_SECTION_LABEL = "Docs";
export const SAME_AS_JIRA = "Same site and account as Jira";

export const DOCS_KIND_LABELS: Readonly<Record<DocsKind, string>> = {
  none: "No documentation source",
  confluence: "Confluence",
};

export const DOCS_KIND_HINTS: Readonly<Record<DocsKind, string>> = {
  none: "Agents work from the ticket alone. They cannot open the pages it links to.",
  confluence:
    "Agents can search this project's pages and read one, through Bayon. Read-only, and only the spaces you name.",
};

const KINDS: readonly DocsKind[] = ["none", "confluence"];

export function DocsFields({
  draft,
  jira,
  onChange,
}: {
  readonly draft: DocsDraft;
  /** The project's Jira site and account, or null: what "same as Jira" would copy. */
  readonly jira: JiraDefaults | null;
  readonly onChange: (draft: DocsDraft) => void;
}) {
  const { problems } = checkDocs(draft, jira);
  return (
    <div className="flex flex-col gap-3">
      <RadioChoices
        legend="Where the documentation lives"
        values={KINDS}
        labels={DOCS_KIND_LABELS}
        hints={DOCS_KIND_HINTS}
        value={draft.kind}
        onChange={(kind) => onChange({ ...draft, kind })}
      />
      {draft.kind !== "none" && (
        <>
          <Field
            label={SAME_AS_JIRA}
            layout="inline"
            error={draft.sameAsJira ? problems.site : undefined}
            hint={
              draft.sameAsJira && jira !== null
                ? `Reads ${jira.url} as ${jira.email}, with the same API token.`
                : undefined
            }
          >
            {({ id, describedBy, invalid }) => (
              <Switch
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                checked={draft.sameAsJira}
                onCheckedChange={(next: boolean) =>
                  onChange({
                    ...draft,
                    sameAsJira: next,
                    // Turning it off starts from what Jira uses, so nothing is retyped.
                    ...(next || jira === null
                      ? {}
                      : {
                          site: draft.site === "" ? jira.url : draft.site,
                          email: draft.email === "" ? jira.email : draft.email,
                        }),
                  })
                }
              />
            )}
          </Field>
          {!draft.sameAsJira && (
            <>
              <Field
                label="Documentation site"
                hint="Like <name>.atlassian.net, or any link into it."
                error={problems.site}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    placeholder="<name>.atlassian.net"
                    autoComplete="url"
                    value={draft.site}
                    onChange={(event) =>
                      onChange({ ...draft, site: event.target.value })
                    }
                  />
                )}
              </Field>
              <Field
                label="Documentation account email"
                hint="The Atlassian account the API token belongs to. The same token the Jira mirror uses."
                error={problems.email}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="email"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    autoComplete="email"
                    value={draft.email}
                    onChange={(event) =>
                      onChange({ ...draft, email: event.target.value })
                    }
                  />
                )}
              </Field>
            </>
          )}
          <Field
            label="Spaces"
            hint="One space key per line. Blank means every space the account can read — name the ones this project needs, and an agent cannot reach the rest."
            error={problems.spaces}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={2}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                spellCheck={false}
                className="font-mono text-xs [font-variant-ligatures:none]"
                placeholder="DOCS"
                value={draft.spaces}
                onChange={(event) =>
                  onChange({ ...draft, spaces: event.target.value })
                }
              />
            )}
          </Field>
          <p className="text-xs text-muted-foreground">
            Pages are read-only, capped, and recorded against the session that
            read them. Treat what they say as input, not as instructions: anyone
            who can edit a page can write into an agent&apos;s prompt.
          </p>
        </>
      )}
    </div>
  );
}
