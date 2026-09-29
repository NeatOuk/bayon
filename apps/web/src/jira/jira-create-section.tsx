import type { JiraSyncResult } from "@bayon/proto";
import { Field } from "@/components/field";
import { Switch } from "@/components/ui/switch";
import { isSyncRunning, unrecordedRefusal } from "@/jira/jira-api";
import { checkJira, type JiraDraft } from "@/jira/jira-form";
import { JiraSourceFields } from "@/jira/jira-source-fields";
import { JiraTokenStep } from "@/jira/jira-token-step";

// New project's optional Jira section, and the one line its first sync leaves on the ready screen.

export const JIRA_SECTION_LABEL = "Mirror tickets from Jira";

/** The ready screen's one link after a create with Jira: the IDE's Tickets view, where the strip is. */
export const OPEN_TICKETS = "Open its Tickets";

/** Off by default. On, the source's fields and the token step (`GET /jira`, asked as it opens). */
export function JiraCreateSection({
  on,
  draft,
  onToggle,
  onChange,
}: {
  readonly on: boolean;
  readonly draft: JiraDraft;
  readonly onToggle: (on: boolean) => void;
  readonly onChange: (draft: JiraDraft) => void;
}) {
  const incomplete = on && checkJira(draft).source === null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <Field
        label={JIRA_SECTION_LABEL}
        layout="inline"
        hint={
          <>
            One way, Jira to Bayon: each To Do issue your query matches becomes
            a backlog ticket.
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
          <JiraSourceFields draft={draft} onChange={onChange} />
          <JiraTokenStep />
          {incomplete && (
            <p className="text-sm text-muted-foreground">
              Complete the site, the account email and the project key, or turn
              the mirror off.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The create's one background sync, as its mutation reports it. */
export interface FirstSync {
  readonly status: "idle" | "pending" | "success" | "error";
  readonly data: JiraSyncResult | undefined;
  readonly error: unknown;
}

function describe(sync: FirstSync): string {
  if (sync.status === "success" && sync.data !== undefined)
    return `First Jira sync: ${sync.data.created} created, ${sync.data.ignored} not To Do. ${OPEN_TICKETS} to see them.`;
  if (sync.status !== "error")
    return `Syncing from Jira… ${OPEN_TICKETS} for the result.`;
  if (isSyncRunning(sync.error))
    return `A Jira sync is already running. ${OPEN_TICKETS} for the result.`;
  const said = unrecordedRefusal(sync.error);
  return `The first Jira sync did not finish${said === null ? "" : `: ${said}`}. ${OPEN_TICKETS} to see the last sync and what to fix.`;
}

/**
 * How the create's one background sync went. No link of its own: it points at the ready screen's
 * one, whose Tickets view strip has the whole of it.
 */
export function FirstSyncLine({ sync }: { readonly sync: FirstSync }) {
  if (sync.status === "idle") return null;
  // Muted even when it failed: the project is made, and the strip carries the reason and the fix.
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {describe(sync)}
    </p>
  );
}
