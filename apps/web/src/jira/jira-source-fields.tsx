import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  JQL_MISSING,
  checkJira,
  withJql,
  withKey,
  type JiraDraft,
} from "@/jira/jira-form";

// The Jira source's fields — site, account, project key, and the query under Advanced — shared by
// the New project form and the Tickets view's strip, so both take and refuse exactly the same.

export function JiraSourceFields({
  draft,
  onChange,
}: {
  readonly draft: JiraDraft;
  readonly onChange: (draft: JiraDraft) => void;
}) {
  const { problems, site } = checkJira(draft);
  // Open from the start when the query is already the operator's own.
  const [advanced, setAdvanced] = useState(draft.jqlEdited);
  const siteHint =
    site === null ? (
      "Like <name>.atlassian.net, or any link into it."
    ) : (
      <>
        {"Mirrors from "}
        <span className="font-mono [font-variant-ligatures:none]">{site}</span>
      </>
    );
  return (
    <div className="flex flex-col gap-3">
      <Field label="Jira site" hint={siteHint} error={problems.site}>
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
        label="Account email"
        hint="The Atlassian account the API token belongs to."
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
      <Field
        label="Jira project key"
        hint={
          draft.jqlEdited
            ? "Your query under Advanced decides what is mirrored."
            : draft.jql === ""
              ? JQL_MISSING
              : "Mirrors its To Do issues, epics left out, in rank order."
        }
        error={problems.key}
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            placeholder="KITE"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono"
            value={draft.key}
            onChange={(event) => onChange(withKey(draft, event.target.value))}
          />
        )}
      </Field>
      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger className="group/advanced flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <ChevronRightIcon
            aria-hidden
            className="size-4 transition-transform group-data-[panel-open]/advanced:rotate-90"
          />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pt-2">
            <Field
              label="Query (JQL)"
              hint="The project key fills this in until you edit it. Only its To Do issues are mirrored."
              error={problems.jql}
            >
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  spellCheck={false}
                  className="font-mono text-xs [font-variant-ligatures:none]"
                  value={draft.jql}
                  onChange={(event) =>
                    onChange(withJql(draft, event.target.value))
                  }
                />
              )}
            </Field>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
