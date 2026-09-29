import type {
  CreateProjectRequest,
  DeliveryConfigView,
  ProjectCreated,
  RunnerView,
} from "@bayon/proto";
import { NO_DELIVERY } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChoiceField } from "@/components/choice-field";
import { Field } from "@/components/field";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { TextLink } from "@/components/text-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { executorsQuery } from "@/executors/executors-api";
import { afterJiraSync, syncProjectJira } from "@/jira/jira-api";
import {
  FirstSyncLine,
  JiraCreateSection,
  OPEN_TICKETS,
} from "@/jira/jira-create-section";
import { BLANK_JIRA, checkJira, type JiraDraft } from "@/jira/jira-form";
import { DeliveryCreateSection } from "@/delivery/delivery-create-section";
import { DocsCreateSection } from "@/docs/docs-create-section";
import {
  BLANK_DOCS,
  checkDocs,
  type DocsDraft,
  type JiraDefaults,
} from "@/docs/docs-form";
import { QaCreateSection } from "@/qa/qa-create-section";
import { BLANK_QA, checkQa, type QaDraft } from "@/qa/qa-form";
import { createProject } from "@/projects/projects-api";
import { runnersQuery } from "@/runners/runners-api";
import { PROJECTS_HREF, projectHref, ticketsHref } from "@/routing";
import { certificationOn } from "@/ide/runner-certification";

interface Form {
  readonly name: string;
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly runnerId: string | null;
  readonly executorId: string | null;
  readonly orchestrator: boolean;
  readonly reviewerOn: boolean;
  /** Null while unset: the reviewer runs on `runnerId`. */
  readonly reviewerRunnerId: string | null;
  /** Mirror tickets from Jira: off by default. */
  readonly jiraOn: boolean;
  readonly jira: JiraDraft;
  /** Set up a QA harness: off by default, and settable later in Settings. */
  readonly qaOn: boolean;
  readonly qa: QaDraft;
  /** Let agents read the project's docs: off by default, settable later in Settings. */
  readonly docsOn: boolean;
  readonly docs: DocsDraft;
  /** Where finished work goes: `none` by default — nothing leaves this machine. */
  readonly delivery: DeliveryConfigView;
}

const BLANK: Form = {
  name: "",
  repoUrl: "",
  baseBranch: "",
  runnerId: null,
  executorId: "local",
  orchestrator: true,
  reviewerOn: true,
  reviewerRunnerId: null,
  jiraOn: false,
  jira: BLANK_JIRA,
  qaOn: false,
  qa: BLANK_QA,
  docsOn: false,
  docs: BLANK_DOCS,
  delivery: NO_DELIVERY,
};

/** What "same as Jira" would copy on this form: the Jira source it is about to send, if any. */
const jiraDefaultsIn = (form: Form): JiraDefaults | null => {
  const source = form.jiraOn ? checkJira(form.jira).source : null;
  return source === null ? null : { url: source.url, email: source.email };
};

/**
 * The POST body from the form, or null while a required field is unset — the Jira source's
 * included, once its section is on.
 */
function requestOf(form: Form): CreateProjectRequest | null {
  const name = form.name.trim();
  const repoUrl = form.repoUrl.trim();
  const jira = form.jiraOn ? checkJira(form.jira).source : undefined;
  const qa = form.qaOn ? checkQa(form.qa, form.delivery).config : undefined;
  const docs = form.docsOn
    ? checkDocs(form.docs, jiraDefaultsIn(form)).source
    : undefined;
  if (
    name === "" ||
    repoUrl === "" ||
    form.runnerId === null ||
    form.executorId === null ||
    jira === null ||
    qa === null ||
    docs === null
  ) {
    return null;
  }
  return {
    name,
    repo_url: repoUrl,
    runner_id: form.runnerId,
    executor_id: form.executorId,
    orchestrator: form.orchestrator,
    reviewer_runner_id: form.reviewerOn
      ? (form.reviewerRunnerId ?? form.runnerId)
      : null,
    ...(form.baseBranch.trim() === ""
      ? {}
      : { base_branch: form.baseBranch.trim() }),
    ...(jira === undefined ? {} : { jira }),
    ...(qa === undefined ? {} : { qa }),
    ...(docs === undefined ? {} : { docs }),
    // `none` is the default the server already holds: only a real choice is sent.
    ...(form.delivery.mode === "none" ? {} : { delivery: form.delivery }),
  };
}

/**
 * The runner certified on the executor for the models its roles run (per model) — what
 * `frm project add` warns about otherwise. An unknown runner is not.
 */
const isCertified = (
  runners: readonly RunnerView[],
  runnerId: string,
  executorId: string,
): boolean => {
  const runner = runners.find((r) => r.id === runnerId);
  return (
    runner !== undefined && certificationOn(runner, executorId) === "certified"
  );
};

/** Every warning `frm project add` would print for this form: shown, never blocking submit. */
function warningsOf(
  form: Form,
  runners: readonly RunnerView[],
): readonly string[] {
  const runnerId = form.runnerId;
  const executorId = form.executorId;
  if (runnerId === null || executorId === null) return [];
  const reviewerRunnerId = form.reviewerOn
    ? (form.reviewerRunnerId ?? runnerId)
    : null;
  const runnerIds = [
    ...new Set([
      runnerId,
      ...(reviewerRunnerId === null ? [] : [reviewerRunnerId]),
    ]),
  ];
  const warnings = runnerIds
    .filter((id) => !isCertified(runners, id, executorId))
    .map(
      (id) =>
        `${id} is not certified on ${executorId}: the write still happens, but unattended work needs it certified.`,
    );
  if (reviewerRunnerId !== null) {
    const reviewer = runners.find((r) => r.id === reviewerRunnerId);
    if (reviewer?.caps?.outputSchema !== true) {
      warnings.push(
        `${reviewerRunnerId} has no structured output: plan reviews will run, but code reviews need one bound to code_reviewer.`,
      );
    }
  }
  return warnings;
}

/**
 * New project: a repo, a workspace, a build profile and builder agent; unless turned
 * off, an orchestrate profile/agent and a review profile/agent on the reviewer's own runner. Warns
 * the way `frm project add` does, but never blocks the write: `POST /projects` is the real gate.
 * Optionally a Jira source, synced once in the background after the create.
 */
export function NewProjectScreen() {
  const [form, setForm] = useState<Form>(BLANK);
  const [created, setCreated] = useState<ProjectCreated | null>(null);
  const runners = useQuery(runnersQuery);
  const executors = useQuery(executorsQuery);
  const queryClient = useQueryClient();
  // Once, after a create that carried a source: never blocks the ready screen, which says how it went.
  const firstSync = useMutation({
    mutationFn: syncProjectJira,
    onSettled: (_result, _error, project) =>
      afterJiraSync(queryClient, project),
  });
  const create = useMutation({
    mutationFn: createProject,
    onSuccess: (project, request) => {
      setCreated(project);
      if (request.jira !== undefined) firstSync.mutate(project.workspace_id);
    },
  });

  const set = (patch: Partial<Form>) => {
    setForm((current) => ({ ...current, ...patch }));
    create.reset();
  };

  const request = requestOf(form);
  const error = create.error?.message ?? null;
  const warnings = warningsOf(form, runners.data?.runners ?? []);
  const runnerIds = (runners.data?.runners ?? []).map((r) => r.id);
  const executorIds = (executors.data?.executors ?? []).map((e) => e.id);

  // The create's own request: whether it carried a Jira source (reset with the mutation).
  const withJira = create.variables?.jira !== undefined;

  if (created !== null) {
    return (
      <PageContainer size="prose">
        <PageHeader title="New project" />
        <p>{`Project ${form.name.trim()} is ready.`}</p>
        {created.submodule_repo_ids.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-sm">
              {`With its ${created.submodule_repo_ids.length} submodules, each checked out inside it:`}
            </p>
            <ul aria-label="submodules" className="flex flex-wrap gap-1">
              {created.submodule_repo_ids.map((id) => (
                <li key={id} className="font-mono text-xs">
                  {id}
                </li>
              ))}
            </ul>
          </div>
        )}
        {created.warnings.length > 0 && (
          // What creation noticed about a folder's own remote (039): a credential taken out of
          // it, or an origin no push can reach. Settings → Delivery is where to fix either.
          <ul aria-label="warnings" className="flex flex-col gap-1">
            {created.warnings.map((warning) => (
              <li key={warning} role="note" className="text-sm text-danger">
                {warning}
              </li>
            ))}
          </ul>
        )}
        <p className="flex gap-3 text-sm">
          {/* With Jira, the one link is the IDE's Tickets view: its strip shows the first sync. */}
          {withJira ? (
            <TextLink href={projectHref(created.workspace_id, "tickets")}>
              {OPEN_TICKETS}
            </TextLink>
          ) : (
            <TextLink href={ticketsHref(created.workspace_id)}>
              Its tickets
            </TextLink>
          )}
          <TextLink href={PROJECTS_HREF}>All projects</TextLink>
        </p>
        <FirstSyncLine sync={firstSync} />
        <p className="text-sm text-muted-foreground">
          {created.orchestrator_agent_id === null
            ? `Stand up a session on ${created.builder_agent_id}.`
            : `Stand up a session on ${created.builder_agent_id}, or staff a mission on ${created.orchestrator_agent_id}.`}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setForm(BLANK);
            setCreated(null);
            create.reset();
            firstSync.reset();
          }}
        >
          Create another
        </Button>
      </PageContainer>
    );
  }

  return (
    <PageContainer size="prose">
      <PageHeader title="New project" />
      <p className="text-sm text-muted-foreground">
        Creates what &quot;frm project add&quot; creates: a repo, a workspace, a
        build profile and a builder agent, and unless turned off an orchestrate
        profile/agent and a review profile/agent.
      </p>
      <div className="flex max-w-xl flex-col gap-4">
        <Field label="Name">
          {({ id }) => (
            <Input
              id={id}
              value={form.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          )}
        </Field>
        <Field
          label="Repo URL"
          hint={
            <>
              https, ssh, or an absolute folder path inside one allowed from a
              shell (a folder with submodules becomes one project, its
              submodules inside it) with{" "}
              <span className="font-mono">
                frm settings set projects.local_roots &lt;folder&gt; --yes
              </span>
            </>
          }
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={form.repoUrl}
              onChange={(event) => set({ repoUrl: event.target.value })}
            />
          )}
        </Field>
        <Field label="Base branch (optional)">
          {({ id }) => (
            <Input
              id={id}
              value={form.baseBranch}
              onChange={(event) => set({ baseBranch: event.target.value })}
            />
          )}
        </Field>
        <ChoiceField
          label="Runner"
          value={form.runnerId}
          options={runnerIds}
          onChange={(runnerId) => set({ runnerId })}
        />
        <ChoiceField
          label="Executor"
          value={form.executorId}
          options={executorIds}
          onChange={(executorId) => set({ executorId })}
        />
        <Field label="Orchestrator" layout="inline">
          {({ id }) => (
            <Switch
              id={id}
              checked={form.orchestrator}
              onCheckedChange={(on: boolean) => set({ orchestrator: on })}
            />
          )}
        </Field>
        <Field label="Reviewer" layout="inline">
          {({ id }) => (
            <Switch
              id={id}
              checked={form.reviewerOn}
              onCheckedChange={(on: boolean) => set({ reviewerOn: on })}
            />
          )}
        </Field>
        {form.reviewerOn && (
          <ChoiceField
            label="Reviewer runner"
            value={form.reviewerRunnerId}
            none="(same as runner)"
            options={runnerIds}
            onChange={(reviewerRunnerId) => set({ reviewerRunnerId })}
          />
        )}
        <JiraCreateSection
          on={form.jiraOn}
          draft={form.jira}
          onToggle={(jiraOn) => set({ jiraOn })}
          onChange={(jira) => set({ jira })}
        />
        <QaCreateSection
          on={form.qaOn}
          draft={form.qa}
          delivery={form.delivery}
          onToggle={(qaOn) => set({ qaOn })}
          onChange={(qa) => set({ qa })}
        />
        <DocsCreateSection
          on={form.docsOn}
          draft={form.docs}
          jira={jiraDefaultsIn(form)}
          // Turned on, it starts from the Jira source this form carries, when it carries one.
          onToggle={(docsOn) =>
            set({
              docsOn,
              docs: {
                ...form.docs,
                sameAsJira: jiraDefaultsIn(form) !== null,
              },
            })
          }
          onChange={(docs) => set({ docs })}
        />
        <DeliveryCreateSection
          draft={form.delivery}
          onChange={(delivery) => set({ delivery })}
        />
        {warnings.map((warning) => (
          <p key={warning} className="text-sm text-muted-foreground">
            {`warning: ${warning}`}
          </p>
        ))}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          disabled={request === null || create.isPending}
          onClick={() => {
            if (request !== null) create.mutate(request);
          }}
        >
          Create
        </Button>
      </div>
    </PageContainer>
  );
}
