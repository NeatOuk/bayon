import type { ProjectView, PushTargetView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Field } from "@/components/field";
import { SettingsSection } from "@/components/settings-section";
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
import { Input } from "@/components/ui/input";
import { notify } from "@/components/ui/toast";
import {
  changesOf,
  detectPushTargets,
  draftsOf,
  problemOf,
  reposInOrder,
  setPushTargets,
} from "@/delivery/push-targets-api";
import { afterProjectWrite } from "@/ide/orchestrator-api";

// Where each of a project's repos has its delivered work pushed (migration 039). A project created
// from a folder fetches from that folder, and without a push target its work would be pushed back
// into it. Detect reads each folder's own origin and fills the fields — it saves nothing; Save asks
// first, then writes `PATCH /projects/:id {push_urls}`, audited `project.set`.

export const PUSH_TARGETS_LABEL = "Push targets";

/** A repo's name in the list: its submodule path, or its id for the primary. */
const nameOf = (repo: { id: string; submodule_path: string | null }) =>
  repo.submodule_path ?? repo.id;

/** The confirmation's list: each change as `<repo> → <target>`, or back to its origin. */
function ChangeList({
  changes,
}: {
  readonly changes: readonly { repo_id: string; push_url: string | null }[];
}) {
  return (
    <ul className="flex flex-col gap-1 font-mono text-xs">
      {changes.map((c) => (
        <li key={c.repo_id}>
          {`${c.repo_id} → ${c.push_url ?? "its origin (no push target)"}`}
        </li>
      ))}
    </ul>
  );
}

/** One repo's row: its name, its field, and what it pushes to while the field is blank. */
function TargetRow({
  repo,
  value,
  note,
  onChange,
}: {
  readonly repo: ProjectView["repos"][number];
  readonly value: string;
  readonly note: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Field
        label={`Push target for ${nameOf(repo)}`}
        hint={`Blank pushes to its origin: ${repo.origin_url ?? "none recorded"}`}
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={value}
            spellCheck={false}
            className="font-mono"
            placeholder="git@host:owner/repo.git"
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </Field>
      {note !== undefined && (
        <p role="note" className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}

export function PushTargets({ project }: { readonly project: ProjectView }) {
  const queryClient = useQueryClient();
  const repos = reposInOrder(project.repos);
  const [drafts, setDrafts] = useState(() => draftsOf(repos));
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const [asking, setAsking] = useState(false);
  const changes = changesOf(repos, drafts);
  const problem = problemOf(changes);

  const detect = useMutation({
    mutationFn: () => detectPushTargets(project.id),
    onSuccess: ({ targets }) => {
      setDrafts((known) => ({
        ...known,
        ...Object.fromEntries(
          targets.flatMap((t) =>
            t.detected === null ? [] : [[t.repo_id, t.detected]],
          ),
        ),
      }));
      setNotes(
        Object.fromEntries(
          targets.flatMap((t) =>
            t.warning === null ? [] : [[t.repo_id, t.warning]],
          ),
        ),
      );
    },
  });

  const save = useMutation({
    mutationFn: () => setPushTargets(project.id, changes),
    onSuccess: async (state) => {
      setAsking(false);
      notify.success("Saved the push targets");
      const saved = new Map(
        state.push_targets.map((t: PushTargetView) => [t.repo_id, t.push_url]),
      );
      const next = project.repos.map((r) => ({
        ...r,
        push_url: saved.has(r.id) ? (saved.get(r.id) ?? null) : r.push_url,
      }));
      setDrafts(draftsOf(next));
      await afterProjectWrite(queryClient, project.id, { repos: next });
    },
  });

  return (
    <SettingsSection
      title={PUSH_TARGETS_LABEL}
      description="Where each repository's finished work is pushed. A project made from a folder should push to that folder's own remote, not back into the folder. An https://, ssh:// or git@host:path URL, never with a password in it."
      footer={
        <>
          <Button
            type="button"
            disabled={
              changes.length === 0 || problem !== null || save.isPending
            }
            onClick={() => {
              save.reset();
              setAsking(true);
            }}
          >
            Save push targets
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={detect.isPending}
            onClick={() => detect.mutate()}
          >
            {detect.isPending ? "Detecting…" : "Detect from folder"}
          </Button>
        </>
      }
    >
      <div
        role="group"
        aria-label={PUSH_TARGETS_LABEL}
        className="flex max-w-xl flex-col gap-4"
      >
        {repos.map((repo) => (
          <TargetRow
            key={repo.id}
            repo={repo}
            value={drafts[repo.id] ?? ""}
            note={notes[repo.id]}
            onChange={(value) => {
              save.reset();
              setDrafts((known) => ({ ...known, [repo.id]: value }));
            }}
          />
        ))}
        {problem !== null && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}
        {detect.isError && (
          <p role="alert" className="text-sm text-danger">
            {`Not detected: ${detect.error.message}`}
          </p>
        )}
      </div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Change where this work is pushed?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Delivered branches will go here from now on. This is recorded in
              the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ChangeList changes={changes} />
          {save.isError && (
            <p role="alert" className="text-sm text-danger">
              {`Not saved: ${save.error.message}`}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
