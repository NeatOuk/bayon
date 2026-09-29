import type { JiraPushConfig, JiraPushView, ProjectView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Field } from "@/components/field";
import { SectionSave, SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/components/ui/toast";
import { afterProjectWrite } from "@/ide/orchestrator-api";
import { fetchJiraStatuses, setProjectJiraPush } from "@/jira/jira-api";

// What goes back to a mirrored project's Jira issues: the status each moment moves an
// issue to, and whether pull requests are commented. Each status is optional — left blank, that
// moment moves nothing — and is a name the site already has, offered from "Load statuses from
// Jira". Saved with `PATCH /projects/:id {jira_push}`, audited `project.set`; saving is the
// standing approval for Bayon to write to Jira with the mirror's own token.

export const JIRA_PUSH_LABEL = "Update Jira as the ticket moves";

/** The longest status name the server takes (core JIRA_STATUS_NAME_MAX). */
const NAME_MAX = 100;

const MOMENTS = [
  {
    key: "started",
    label: "When work starts",
    hint: "The ticket is staffed or its build begins.",
  },
  {
    key: "in_review",
    label: "When a pull request opens",
    hint: "Delivery opened a pull request for it.",
  },
  {
    key: "done",
    label: "When it is done",
    hint: "The ticket is done in Bayon.",
  },
] as const;

type Moment = (typeof MOMENTS)[number]["key"];

interface PushDraft {
  readonly names: Readonly<Record<Moment, string>>;
  readonly comment_prs: boolean;
}

export const pushDraftOf = (v: JiraPushView): PushDraft => ({
  names: {
    started: v.status_map.started ?? "",
    in_review: v.status_map.in_review ?? "",
    done: v.status_map.done ?? "",
  },
  comment_prs: v.comment_prs,
});

/** The draft as the server takes it: a blank name is no move; null when a name is too long. */
export function checkPush(d: PushDraft): JiraPushConfig | null {
  const names = MOMENTS.map((m) => [m.key, d.names[m.key].trim()] as const);
  if (names.some(([, n]) => n.length > NAME_MAX)) return null;
  return {
    status_map: Object.fromEntries(names.filter(([, n]) => n !== "")),
    comment_prs: d.comment_prs,
  };
}

export function JiraPushSection({
  project,
}: {
  readonly project: ProjectView;
}) {
  const queryClient = useQueryClient();
  const listId = useId();
  const [draft, setDraft] = useState(() => pushDraftOf(project.jira_push));
  const statuses = useMutation({
    mutationFn: () => fetchJiraStatuses(project.id),
  });
  const save = useMutation({
    mutationFn: () => {
      const checked = checkPush(draft);
      if (checked === null) throw new Error("a status name is too long");
      return setProjectJiraPush(project.id, checked);
    },
    onSuccess: async (state) => {
      setDraft(pushDraftOf(state.jira_push));
      notify.success("Saved the Jira updates");
      await afterProjectWrite(queryClient, project.id, {
        jira_push: state.jira_push,
      });
    },
  });
  const change = (next: PushDraft) => {
    save.reset();
    setDraft(next);
  };
  const ready = checkPush(draft) !== null;
  return (
    <SettingsSection
      title={JIRA_PUSH_LABEL}
      description="Move each mirrored issue to a Jira status of your choosing as its ticket moves here. Leave a status blank to leave Jira alone at that point. A status Jira cannot reach from where the issue is is skipped, never guessed."
      form={{
        label: JIRA_PUSH_LABEL,
        onSubmit: () => {
          if (ready) save.mutate();
        },
      }}
      footer={
        <SectionSave
          label="Save Jira updates"
          pending={save.isPending}
          disabled={!ready}
          error={save.isError ? save.error.message : null}
        />
      }
    >
      <div className="flex max-w-xl flex-col gap-4">
        <datalist id={listId}>
          {(statuses.data?.statuses ?? []).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {MOMENTS.map((m) => (
          <StatusField
            key={m.key}
            label={m.label}
            hint={m.hint}
            list={listId}
            value={draft.names[m.key]}
            onChange={(value) =>
              change({ ...draft, names: { ...draft.names, [m.key]: value } })
            }
          />
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={statuses.isPending}
            onClick={() => statuses.mutate()}
          >
            {statuses.isPending ? "Loading…" : "Load statuses from Jira"}
          </Button>
          {statuses.isSuccess && (
            <span role="status" className="text-xs text-muted-foreground">
              {`${statuses.data.statuses.length} statuses offered.`}
            </span>
          )}
          {statuses.isError && (
            <span role="alert" className="text-xs text-danger">
              {`Could not load statuses: ${statuses.error.message}`}
            </span>
          )}
        </div>
        <CommentSwitch
          on={draft.comment_prs}
          onChange={(on) => change({ ...draft, comment_prs: on })}
        />
        <p className="text-xs text-muted-foreground">
          Bayon writes with the mirror&apos;s own token: its account needs
          Jira&apos;s <strong>Transition Issues</strong> and{" "}
          <strong>Add Comments</strong> permissions in the issues&apos; project.
          Saving is your approval for these writes.
        </p>
      </div>
    </SettingsSection>
  );
}

function StatusField({
  label,
  hint,
  list,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly list: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const tooLong = value.trim().length > NAME_MAX;
  return (
    <Field
      label={label}
      hint={hint}
      error={tooLong ? `At most ${NAME_MAX} characters.` : undefined}
    >
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          list={list}
          value={value}
          placeholder="No change"
          aria-describedby={describedBy}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

function CommentSwitch({
  on,
  onChange,
}: {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <Field
      label="Comment each pull request, and who merged it, on the issue"
      layout="inline"
    >
      {({ id }) => (
        <Switch
          id={id}
          checked={on}
          onCheckedChange={(next: boolean) => onChange(next)}
        />
      )}
    </Field>
  );
}
