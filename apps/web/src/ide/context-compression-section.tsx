import { MODEL_STEPS, type ModelStep } from "@bayon/core";
import type { ProjectView, RoleBindingView, RunnerView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { QueryError } from "@/components/query-error";
import { SettingsSection } from "@/components/settings-section";
import { StatusBadge } from "@/components/status-badge";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/components/ui/toast";
import {
  afterProjectWrite,
  setProjectContextCompression,
} from "@/ide/orchestrator-api";
import { CERTIFICATION_EXECUTOR } from "@/ide/runner-certification";
import { STEP_LABELS, stepModel, type StepModel } from "@/ide/step-models";
import { CopyCommand } from "@/notify/copy-command";
import { runnersQuery } from "@/runners/runners-api";
import { roleBindingsQuery } from "@/settings/roles-api";
import { Muted } from "@/tickets/ticket-sections";

// Project settings → Context compression (spec M12): one switch, off by default. On, the
// sessions this project spawns from then on send their model calls through the context proxy, which
// shortens large tool output (the whole of it stays on disk for the agent to read), where the runner,
// the executor and the role allow it. Such a session is admitted only on a certificate earned with
// compression on, so beside the switch each step model this project runs (Models' resolution) shows
// that certificate, or the command that earns it. Turning it on asks first; off does not. Saved as
// it flips, with `PATCH /projects/:id {context_compression}`, audited `project.set`.

export const CONTEXT_COMPRESSION_SECTION_LABEL = "Context compression";

/** The command that earns `m`'s compression-on certificate on the executor the GUI shows. */
export const certifyCommand = (runnerId: string, modelId: string): string =>
  `frm runner conformance ${runnerId} --model ${modelId} --executor ${CERTIFICATION_EXECUTOR} --compression`;

/** One step's compression-on certificate: its badges, or the command that earns it. */
function StepCertificate({
  step,
  model: m,
}: {
  readonly step: ModelStep;
  readonly model: StepModel;
}) {
  const heading = (
    <span className="text-sm font-medium">{STEP_LABELS[step]}</span>
  );
  if (m.runnerId === null || m.modelId === null || m.model === null) {
    return (
      <div className="flex flex-col gap-1">
        {heading}
        <Muted>{m.problem ?? "No model runs this step."}</Muted>
      </div>
    );
  }
  const certified = m.certification === "certified";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {heading}
        <span className="text-sm text-muted-foreground">{`${m.model} on ${m.runnerId}`}</span>
        {m.certification !== null && (
          <StatusBadge entity="certification" state={m.certification} />
        )}
        {certified && m.gateEligible !== null && (
          <StatusBadge
            entity="eligibility"
            state={m.gateEligible ? "eligible" : "ineligible"}
          />
        )}
      </div>
      {!certified && (
        <CopyCommand
          command={certifyCommand(m.runnerId, m.modelId)}
          label={`the ${STEP_LABELS[step]} step's certification command`}
        />
      )}
    </div>
  );
}

function StepCertificates({
  project,
  runners,
  bindings,
}: {
  readonly project: ProjectView;
  readonly runners: readonly RunnerView[];
  readonly bindings: readonly RoleBindingView[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm">
        {`Certificates earned with compression on, on ${CERTIFICATION_EXECUTOR}:`}
      </span>
      {MODEL_STEPS.map((step) => (
        <StepCertificate
          key={step}
          step={step}
          model={stepModel(
            step,
            project.step_tiers[step],
            project,
            runners,
            bindings,
            { compression: true },
          )}
        />
      ))}
      <Muted>
        A runner that does not compress context, a session on an executor that
        is not local, and the orchestrator run uncompressed, on their normal
        certificate.
      </Muted>
    </div>
  );
}

export function ContextCompressionSection({
  project,
}: {
  readonly project: ProjectView;
}) {
  const queryClient = useQueryClient();
  const runners = useQuery(runnersQuery);
  const bindings = useQuery(roleBindingsQuery);
  const [asking, setAsking] = useState(false);
  const set = useMutation({
    mutationFn: (on: boolean) => setProjectContextCompression(project.id, on),
    onSuccess: async (state) => {
      setAsking(false);
      notify.success(
        state.context_compression
          ? "Context compression is on"
          : "Context compression is off",
      );
      await afterProjectWrite(queryClient, project.id, {
        context_compression: state.context_compression,
      });
    },
  });
  const on = set.data?.context_compression ?? project.context_compression;
  const failed = runners.error ?? bindings.error;
  return (
    <SettingsSection
      title={CONTEXT_COMPRESSION_SECTION_LABEL}
      description="Shorten large tool output, such as long logs and big JSON, before it reaches the model; the whole output stays on disk for the agent to read. Sessions started after a change follow it; the switch saves as you flip it."
    >
      <div className="flex items-center gap-2">
        <Switch
          id="context-compression"
          checked={on}
          disabled={set.isPending}
          onCheckedChange={(next: boolean) => {
            set.reset();
            if (next) setAsking(true);
            else set.mutate(false);
          }}
        />
        <Label htmlFor="context-compression">Compress large tool output</Label>
      </div>
      {set.isError && !asking && (
        <p role="alert" className="text-sm text-danger">
          {`Not saved: ${set.error.message}`}
        </p>
      )}
      {failed !== null ? (
        <QueryError
          title="The certificates each step needs are unavailable"
          error={failed}
          onRetry={() => {
            void runners.refetch();
            void bindings.refetch();
          }}
        />
      ) : runners.data === undefined || bindings.data === undefined ? null : (
        <StepCertificates
          project={project}
          runners={runners.data.runners}
          bindings={bindings.data.items}
        />
      )}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on context compression?</AlertDialogTitle>
            <AlertDialogDescription>
              {`Sessions this project starts from now on send their model calls through Bayon's context proxy, which shortens large tool output. Each is admitted only on a certificate earned with compression on: a step model without one is refused until it is certified. Sessions already running keep what they started with.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {set.isError && (
            <p role="alert" className="text-sm text-danger">
              {`Not saved: ${set.error.message}`}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button disabled={set.isPending} onClick={() => set.mutate(true)}>
              Turn on
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
