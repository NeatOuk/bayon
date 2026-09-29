import type { ProjectView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { SectionSave, SettingsSection } from "@/components/settings-section";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/components/ui/toast";
import { DOCS_SECTION_LABEL, DocsFields } from "@/docs/docs-fields";
import {
  BLANK_DOCS,
  checkDocs,
  docsDraftOf,
  jiraDefaultsOf,
} from "@/docs/docs-form";
import {
  DeliveryFields,
  DELIVERY_SECTION_LABEL,
} from "@/delivery/delivery-fields";
import { PushTargets } from "@/delivery/push-targets";
import {
  afterProjectWrite,
  setProjectDelivery,
  setProjectDocs,
  setProjectQa,
  setStaffApproval,
} from "@/ide/orchestrator-api";
import { ContextCompressionSection } from "@/ide/context-compression-section";
import { StepModelsSection } from "@/ide/step-models-section";
import { JiraPushSection } from "@/jira/jira-push-section";
import { JiraStrip } from "@/jira/jira-strip";
import { QA_SECTION_LABEL, QaFields } from "@/qa/qa-fields";
import { BLANK_QA, checkQa, qaDraftOf } from "@/qa/qa-form";

// The project IDE's Settings view (//): the one place where a project is configured — its Jira source and what goes back to
// Jira, its QA harness, its documentation source, its delivery, the model tier each step runs, its
// context compression and its staffing approval.
//
// Every write is `PATCH /projects/:id`, audited `project.set` (the staffing switch and the Jira
// source already were). Nothing here writes to the database any other way.

export function SettingsView({ project }: { readonly project: ProjectView }) {
  return (
    <PageContainer size="wide">
      <PageHeader title="Project settings" />
      <SettingsSection
        title="Jira"
        description="Mirror this project's tickets from a Jira query, one way."
      >
        <JiraStrip project={project} level="h3" framed={false} />
      </SettingsSection>
      {project.jira !== null && <JiraPushSection project={project} />}
      <QaSection project={project} />
      <DocsSection project={project} />
      <DeliverySection project={project} />
      <PushTargets project={project} />
      <StepModelsSection project={project} />
      <ContextCompressionSection project={project} />
      <StaffingSection project={project} />
    </PageContainer>
  );
}

/**
 * The documentation source: where it lives, whether it uses the Jira site and account, and which of
 * its spaces an agent may read. A project with a Jira source starts from it — "same as Jira" — and
 * the operator may override either field.
 */
function DocsSection({ project }: { readonly project: ProjectView }) {
  const queryClient = useQueryClient();
  const jira = jiraDefaultsOf(project.jira);
  const [draft, setDraft] = useState(() =>
    project.docs.kind === "none"
      ? { ...BLANK_DOCS, sameAsJira: jira !== null }
      : docsDraftOf(project.docs, jira),
  );
  const save = useMutation({
    mutationFn: () => {
      const checked = checkDocs(draft, jira).source;
      if (checked === null) {
        throw new Error("the documentation source is incomplete");
      }
      return setProjectDocs(project.id, checked);
    },
    onSuccess: async (state) => {
      setDraft(docsDraftOf(state.docs, jira));
      notify.success("Docs settings saved");
      await afterProjectWrite(queryClient, project.id, { docs: state.docs });
    },
  });
  const ready = checkDocs(draft, jira).source !== null;
  return (
    <SettingsSection
      title={DOCS_SECTION_LABEL}
      description="Where this project's documentation lives, so an agent can open the pages a ticket links to instead of working from its summary."
      form={{
        label: "Documentation source",
        onSubmit: () => {
          if (ready) save.mutate();
        },
      }}
      footer={
        <SectionSave
          label="Save docs settings"
          pending={save.isPending}
          disabled={!ready}
          error={save.isError ? save.error.message : null}
        />
      }
    >
      <div className="flex max-w-xl flex-col gap-3">
        <DocsFields
          draft={draft}
          jira={jira}
          onChange={(next) => {
            save.reset();
            setDraft(next);
          }}
        />
      </div>
    </SettingsSection>
  );
}

/** The QA harness: the mode, and for `command` the command and what it needs. */
function QaSection({ project }: { readonly project: ProjectView }) {
  const queryClient = useQueryClient();
  const repoIds = project.repos.map((r) => r.id);
  const [draft, setDraft] = useState(() =>
    project.qa.mode === "none" && project.qa.cmd === null
      ? BLANK_QA
      : qaDraftOf(project.qa),
  );
  const save = useMutation({
    mutationFn: () => {
      const checked = checkQa(draft, project.delivery, repoIds).config;
      if (checked === null) throw new Error("the QA settings are incomplete");
      return setProjectQa(project.id, checked);
    },
    onSuccess: async (state) => {
      setDraft(qaDraftOf(state.qa));
      notify.success(
        "QA settings saved",
        state.qa_ticket === null
          ? undefined
          : `${state.qa_ticket} asks an agent to build the harness; switch this to “Run a command” once it lands.`,
      );
      await afterProjectWrite(queryClient, project.id, { qa: state.qa });
    },
  });
  const ready = checkQa(draft, project.delivery, repoIds).config !== null;
  return (
    <SettingsSection
      title={QA_SECTION_LABEL}
      description="What has to pass before this project's work reaches human QA. Bayon knows one thing about it: a command that exits non-zero when the project is broken."
      form={{
        label: "QA harness",
        onSubmit: () => {
          if (ready) save.mutate();
        },
      }}
      footer={
        <SectionSave
          label="Save QA settings"
          pending={save.isPending}
          disabled={!ready}
          error={save.isError ? save.error.message : null}
        />
      }
    >
      <div className="flex max-w-xl flex-col gap-3">
        <QaFields
          draft={draft}
          delivery={project.delivery}
          repoIds={repoIds}
          onChange={(next) => {
            save.reset();
            setDraft(next);
          }}
        />
      </div>
    </SettingsSection>
  );
}

/**
 * Where this project's finished work goes, and — per repo — where it is pushed (039). Saving anything but "keep the work here" is
 * the operator's standing approval for the pushes and pull requests the supervisor then makes, which
 * is why it is an audited `project.set` like everything else on this screen (§14).
 */
function DeliverySection({ project }: { readonly project: ProjectView }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(project.delivery);
  const save = useMutation({
    mutationFn: () => setProjectDelivery(project.id, draft),
    onSuccess: async (state) => {
      setDraft(state.delivery);
      notify.success("Delivery settings saved");
      await afterProjectWrite(queryClient, project.id, {
        delivery: state.delivery,
      });
    },
  });
  return (
    <SettingsSection
      title={DELIVERY_SECTION_LABEL}
      description="How this project's finished work reaches the people who asked for it."
      form={{ label: DELIVERY_SECTION_LABEL, onSubmit: () => save.mutate() }}
      footer={
        <SectionSave
          label="Save delivery settings"
          pending={save.isPending}
          error={save.isError ? save.error.message : null}
        />
      }
    >
      <div className="flex max-w-xl flex-col gap-3">
        <DeliveryFields
          existing
          draft={draft}
          onChange={(next) => {
            save.reset();
            setDraft(next);
          }}
        />
      </div>
    </SettingsSection>
  );
}

/** The staffing approval switch, which `PATCH /projects/:id` has written since an earlier change. */
function StaffingSection({ project }: { readonly project: ProjectView }) {
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (on: boolean) => setStaffApproval(project.id, on),
    onSuccess: (state) =>
      afterProjectWrite(queryClient, project.id, {
        staff_approval: state.staff_approval,
      }),
  });
  const on = set.data?.staff_approval ?? project.staff_approval;
  return (
    <SettingsSection
      title="Staffing"
      description="Whether this project's orchestrator starts sessions itself, or proposes them for you to approve. The switch saves as you flip it."
    >
      <div className="flex items-center gap-2">
        <Switch
          id="staff-approval"
          checked={on}
          disabled={set.isPending}
          onCheckedChange={(next: boolean) => set.mutate(next)}
        />
        <Label htmlFor="staff-approval">Approve staffing myself</Label>
      </div>
      {set.isError && (
        <p role="alert" className="text-sm text-danger">
          {`Not saved: ${set.error.message}`}
        </p>
      )}
    </SettingsSection>
  );
}
