import type { JiraSource, JiraSourceView, ProjectView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loading } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { TextLink } from "@/components/text-link";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { afterProjectWrite } from "@/ide/orchestrator-api";
import {
  afterJiraWrite,
  projectJiraQuery,
  setProjectJira,
} from "@/jira/jira-api";
import { JIRA_SECTION_LABEL } from "@/jira/jira-create-section";
import { BLANK_JIRA, checkJira, draftOf } from "@/jira/jira-form";
import {
  LastSync,
  SyncNotice,
  SyncNowButton,
  useSyncNow,
} from "@/jira/jira-last-sync";
import { jiraProjectHref, siteHostOf } from "@/jira/jira-links";
import { JiraSourceFields } from "@/jira/jira-source-fields";
import { JiraTokenStep } from "@/jira/jira-token-step";
import { cn } from "@/lib/utils";

// The IDE's Tickets view's Jira strip: set a source (the New project form's fields), sync now, the
// last sync, edit or turn off. `PATCH /projects/:id {jira}` writes; the server's answer is shown.

/**
 * `PATCH /projects/:id {jira}`, then the projects cache (the chips' sites) and the strip refetch; a
 * toast says what changed, since the form or the confirm it came from closes.
 */
function useSetJira(project: string, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jira: JiraSource | null) => setProjectJira(project, jira),
    onSuccess: async (state) => {
      onDone();
      notify.success(
        state.jira === null
          ? "The Jira mirror is off"
          : "The Jira source is saved",
        state.jira === null
          ? "The tickets it mirrored stay as they are."
          : undefined,
      );
      await Promise.all([
        afterProjectWrite(queryClient, project, { jira: state.jira }),
        afterJiraWrite(queryClient, project, state.jira),
      ]);
    },
  });
}

/** The source's form: blank to start mirroring, or the stored source to edit. */
function SourceEditor({
  project,
  source,
  level,
  onClose,
}: {
  readonly project: string;
  readonly source: JiraSourceView | null;
  readonly level: "h2" | "h3";
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(
    source === null ? BLANK_JIRA : draftOf(source),
  );
  const save = useSetJira(project, onClose);
  const checked = checkJira(draft).source;
  return (
    <form
      aria-label="Jira source"
      className="flex max-w-xl flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (checked !== null) save.mutate(checked);
      }}
    >
      <JiraSourceFields
        draft={draft}
        onChange={(next) => {
          save.reset();
          setDraft(next);
        }}
      />
      <JiraTokenStep level={level} />
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {`Not saved: ${save.error.message}`}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={checked === null || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Turn off, confirmed: syncs stop; the tickets already mirrored stay. */
function TurnOff({ project }: { readonly project: string }) {
  const [asking, setAsking] = useState(false);
  const off = useSetJira(project, () => setAsking(false));
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          off.reset();
          setAsking(true);
        }}
      >
        Turn off
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off the Jira mirror?</AlertDialogTitle>
            <AlertDialogDescription>
              Syncs stop, by hand and on the timer. The tickets it already
              mirrored stay as they are: nothing is parked or deleted. You can
              turn it on again here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {off.isError && (
            <p role="alert" className="text-sm text-destructive">
              {`Not turned off: ${off.error.message}`}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={off.isPending}
              onClick={() => off.mutate(null)}
            >
              Turn off mirror
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The source in one line: its site, its query (whole in the tooltip), and a link to the project. */
function SourceLine({ source }: { readonly source: JiraSourceView }) {
  const href = jiraProjectHref(source.url, source.jql);
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="font-medium">
        {siteHostOf(source.url) ?? source.url}
      </span>
      <code
        className="max-w-md min-w-0 truncate font-mono text-xs text-muted-foreground [font-variant-ligatures:none]"
        title={source.jql}
      >
        {source.jql}
      </code>
      {href !== null && (
        <TextLink href={href} external>
          Open in Jira
        </TextLink>
      )}
    </div>
  );
}

export function JiraStrip({
  project,
  level = "h2",
  framed = true,
}: {
  readonly project: ProjectView;
  /** Its token step's heading level: h3 when the strip sits inside a section of its own. */
  readonly level?: "h2" | "h3";
  /** Its own card, as a banner; unframed inside a settings section, which is the card. */
  readonly framed?: boolean;
}) {
  const jira = useQuery(projectJiraQuery(project.id));
  const [editing, setEditing] = useState(false);
  const sync = useSyncNow(project.id);
  const source = jira.data?.source ?? null;
  return (
    <section
      aria-label="Jira mirror"
      className={cn(
        "flex flex-col gap-2",
        framed && "rounded-lg border bg-card p-3",
      )}
    >
      {jira.isPending && <Loading label="Loading the Jira mirror…" />}
      {jira.isError && (
        <QueryError
          title="The Jira mirror is unavailable"
          error={jira.error}
          onRetry={() => void jira.refetch()}
        />
      )}
      {jira.data !== undefined && editing && (
        <SourceEditor
          project={project.id}
          source={source}
          level={level}
          onClose={() => setEditing(false)}
        />
      )}
      {jira.data !== undefined && !editing && source === null && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-head text-sm font-medium">Jira</span>
          <span className="text-sm text-muted-foreground">
            Not mirrored from Jira.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setEditing(true)}
          >
            {JIRA_SECTION_LABEL}
          </Button>
        </div>
      )}
      {jira.data !== undefined && !editing && source !== null && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-head text-sm font-medium">Jira</span>
            <SourceLine source={source} />
            <SyncNowButton sync={sync} />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <TurnOff project={project.id} />
          </div>
          <SyncNotice sync={sync} />
          <LastSync
            record={jira.data.last_sync}
            email={source.email}
            now={Date.now()}
          />
          <JiraTokenStep quiet level={level} />
        </>
      )}
    </section>
  );
}
