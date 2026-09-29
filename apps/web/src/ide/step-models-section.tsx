import {
  MODEL_STEPS,
  ModelTier,
  type ModelStep,
  type StepTiers,
} from "@bayon/core";
import type { ProjectView, RoleBindingView, RunnerView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChoiceField } from "@/components/choice-field";
import { QueryError } from "@/components/query-error";
import { SectionSave, SettingsSection } from "@/components/settings-section";
import { StatusBadge } from "@/components/status-badge";
import { notify } from "@/components/ui/toast";
import { afterProjectWrite, setProjectStepTiers } from "@/ide/orchestrator-api";
import { STEP_LABELS, stepModel, type StepModel } from "@/ide/step-models";
import { runnersQuery } from "@/runners/runners-api";
import { roleBindingsQuery } from "@/settings/roles-api";

// Project settings → Models: the tier each step of this project's work runs — planning
// (a spike), building, reviewing (every gate's reviewer) — or Inherit, the agent's own. Beside each,
// the model that step will run, as the spawn resolves it, and what would stop it: no active model of
// the tier, no certificate, or — for review — a certificate that may not review a gate. Saved with
// `PATCH /projects/:id {step_tiers}`, audited `project.set`, like every other section here.

export const MODELS_SECTION_LABEL = "Models";

const INHERIT = "Inherit";

/** "Runs model-big (complex) on runner-a." and whatever stops it, as one line. */
function hintOf(m: StepModel): string {
  const runs =
    m.model === null
      ? null
      : `Runs ${m.model} (${m.tier ?? "?"}) on ${m.runnerId ?? "?"}.`;
  const bound =
    m.boundBy === null
      ? null
      : `The ${m.boundBy} role binding's tier wins over this.`;
  const profile =
    m.profileOf === null
      ? null
      : `Inherited from the ${m.profileOf} role binding's profile.`;
  return [runs, bound, profile, m.problem]
    .filter((part) => part !== null)
    .join(" ");
}

function StepRow({
  step,
  tier,
  project,
  runners,
  bindings,
  onChange,
}: {
  readonly step: ModelStep;
  readonly tier: ModelTier | null;
  readonly project: ProjectView;
  readonly runners: readonly RunnerView[] | undefined;
  readonly bindings: readonly RoleBindingView[] | undefined;
  readonly onChange: (tier: ModelTier | null) => void;
}) {
  const resolved =
    runners === undefined || bindings === undefined
      ? null
      : stepModel(step, tier, project, runners, bindings);
  return (
    <div className="flex flex-col gap-1.5">
      <ChoiceField
        label={STEP_LABELS[step]}
        value={tier}
        none={INHERIT}
        options={ModelTier.options}
        hint={resolved === null ? "Resolving the model…" : hintOf(resolved)}
        onChange={(next) => {
          const picked = ModelTier.safeParse(next);
          onChange(picked.success ? picked.data : null);
        }}
      />
      {resolved?.certification != null && (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge entity="certification" state={resolved.certification} />
          {resolved.gateEligible !== null && (
            <StatusBadge
              entity="eligibility"
              state={resolved.gateEligible ? "eligible" : "ineligible"}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function StepModelsSection({
  project,
}: {
  readonly project: ProjectView;
}) {
  const queryClient = useQueryClient();
  const runners = useQuery(runnersQuery);
  const bindings = useQuery(roleBindingsQuery);
  const [draft, setDraft] = useState<StepTiers>(project.step_tiers);
  const save = useMutation({
    mutationFn: () => setProjectStepTiers(project.id, draft),
    onSuccess: async (state) => {
      setDraft(state.step_tiers);
      notify.success("Model settings saved");
      await afterProjectWrite(queryClient, project.id, {
        step_tiers: state.step_tiers,
      });
    },
  });
  const failed = runners.error ?? bindings.error;
  return (
    <SettingsSection
      title={MODELS_SECTION_LABEL}
      description="The model tier each step of this project's work runs: planning, building, and reviewing (every gate's reviewer). Inherit keeps each agent's own; a role binding's tier still wins."
      form={{ label: MODELS_SECTION_LABEL, onSubmit: () => save.mutate() }}
      footer={
        <SectionSave
          label="Save model settings"
          pending={save.isPending}
          error={save.isError ? save.error.message : null}
        />
      }
    >
      <div className="flex max-w-xl flex-col gap-4">
        {failed !== null && (
          <QueryError
            title="The models each step would run are unavailable"
            error={failed}
            onRetry={() => {
              void runners.refetch();
              void bindings.refetch();
            }}
          />
        )}
        {MODEL_STEPS.map((step) => (
          <StepRow
            key={step}
            step={step}
            tier={draft[step]}
            project={project}
            runners={runners.data?.runners}
            bindings={bindings.data?.items}
            onChange={(tier) => {
              save.reset();
              setDraft((known) => ({ ...known, [step]: tier }));
            }}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
