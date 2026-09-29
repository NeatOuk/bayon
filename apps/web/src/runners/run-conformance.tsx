import {
  RunnerConformanceRequest,
  type CertificationView,
  type ExecutorView,
  type RunnerModelView,
} from "@bayon/proto";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { CommandStatus } from "@/commands/command-status";
import { ChoiceField } from "@/components/choice-field";
import { Button } from "@/components/ui/button";
import {
  defaultExecutor,
  defaultModel,
  modelsInUse,
  modelUseText,
  offeredExecutors,
  progressText,
} from "@/runners/conformance-progress";
import { RUNNERS_KEY, runConformance } from "@/runners/runners-api";

/**
 * "Run conformance" (§15): queues one runner.conformance command for this runner with one of its
 * models (a certificate holds for that model alone — a bound one first) on an executor —
 * the one it was last certified on until another is picked — then follows the command until the
 * supervisor settles it and refreshes the runners. The command's line says how long it has been
 * going and what is queued ahead of it, because the suite takes minutes and runs one at a time
 *.
 *
 * The model offered first is one in use — by a role binding, a project's step tier or an enabled
 * agent — and the line under it says who uses the picked one. With more than one in use,
 * "Certify the N models in use" queues a run for each, which is what a project needs certified.
 *
 * Only enabled executors are offered: the API and the supervisor both refuse a run on
 * a disabled one, so listing it would be offering a choice the server takes back. With none
 * enabled — or none registered — the screen says what to do instead of showing an empty picker and
 * a button that only fails.
 */
export function RunConformance({
  runnerId,
  executors,
  certifications,
  models,
}: {
  readonly runnerId: string;
  readonly executors: readonly ExecutorView[];
  readonly certifications: readonly CertificationView[];
  /** The runner's active models: what a run may certify. */
  readonly models: readonly RunnerModelView[];
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const offered = offeredExecutors(executors);
  const executor = picked ?? defaultExecutor(executors, certifications);
  const model = pickedModel ?? defaultModel(models);
  const inUse = modelsInUse(models);
  const [formError, setFormError] = useState<string | null>(null);
  const [commandIds, setCommandIds] = useState<readonly string[]>([]);
  const run = useMutation({
    mutationFn: async (requests: readonly RunnerConformanceRequest[]) => {
      // One after another: the supervisor runs them one at a time anyway.
      const ids: string[] = [];
      for (const request of requests) {
        const accepted = await runConformance(runnerId, request);
        ids.push(accepted.command_id);
        setCommandIds([...ids]);
      }
      return ids;
    },
  });

  function submit(modelIds: readonly (string | null)[]) {
    const parsed = modelIds.map((modelId) =>
      RunnerConformanceRequest.safeParse({
        executor_id: executor,
        model_id: modelId,
      }),
    );
    const requests = parsed.flatMap((r) => (r.success ? [r.data] : []));
    if (requests.length !== parsed.length || requests.length === 0) {
      setFormError("Pick the executor and the model to run the suite on.");
      return;
    }
    setFormError(null);
    setCommandIds([]);
    run.mutate(requests);
  }

  const error = formError ?? (run.isError ? run.error.message : null);
  if (models.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This runner registers no active model, so there is nothing to certify.
      </p>
    );
  }
  if (offered.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No enabled executor to run the suite on: add or enable one first (frm
        executor add | frm executor enable).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <ChoiceField
          label="Model"
          value={model}
          options={models.map((m) => m.id)}
          disabled={run.isPending}
          className="w-60"
          onChange={setPickedModel}
        />
        <ChoiceField
          label="Executor"
          value={executor}
          options={offered.map((e) => e.id)}
          disabled={run.isPending}
          className="w-52"
          onChange={setPicked}
        />
        <Button
          size="sm"
          disabled={run.isPending}
          onClick={() => submit([model])}
        >
          Run conformance
        </Button>
        {inUse.length > 1 && (
          <Button
            size="sm"
            variant="outline"
            disabled={run.isPending}
            onClick={() => submit(inUse.map((m) => m.id))}
          >
            Certify the {inUse.length} models in use
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {modelUseText(models.find((m) => m.id === model))}
      </p>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {commandIds.map((id) => (
        <CommandStatus
          key={id}
          commandId={id}
          refresh={RUNNERS_KEY}
          describe={(command) => progressText(command, id)}
        />
      ))}
    </div>
  );
}
