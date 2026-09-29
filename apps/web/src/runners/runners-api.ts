import {
  ModelWriteReply,
  RunnerConformanceAccepted,
  RunnerConformanceResult,
  RunnerUpdateDismissed,
  RunnersView,
  type CommandView,
  type ModelCreateRequest,
  type ModelPatchRequest,
  type RunnerConformanceRequest,
} from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { deleteJson, getJson, patchJson, postJson } from "@/api/http";

// The Runners page's REST (§12.1, §15): GET /runners and POST /runners/:id/conformance,
// whose runner.conformance command is followed with commands/ until the supervisor settles it.

const segment = encodeURIComponent;

/** GET /runners; a settled conformance run refreshes it by this key. */
export const RUNNERS_KEY = ["runners"] as const;

export const runnersQuery = queryOptions({
  queryKey: RUNNERS_KEY,
  queryFn: ({ signal }) => getJson("/runners", RunnersView, signal),
});

/** 202 with the runner.conformance command; 404 for an unknown runner or executor. */
export const runConformance = (
  runnerId: string,
  request: RunnerConformanceRequest,
): Promise<RunnerConformanceAccepted> =>
  postJson(
    `/runners/${segment(runnerId)}/conformance`,
    request,
    RunnerConformanceAccepted,
  );

/** A done runner.conformance command's result; null while it runs, or if it does not parse. */
export function conformanceResult(
  command: CommandView,
): RunnerConformanceResult | null {
  const parsed = RunnerConformanceResult.safeParse(command.result);
  return parsed.success ? parsed.data : null;
}

// The operator's models: add, edit and turn off. The server judges each row with the
// runner's adapter and holds one active model per (runner, tier); its refusal comes back as the
// error's message. Settings are not sent from here: `frm config apply … --yes` changes them.

/** 201 with the stored row; 400 what the adapter refuses; 409 the tier rule or a repeated id. */
export const createModel = (
  runnerId: string,
  request: ModelCreateRequest,
): Promise<ModelWriteReply> =>
  postJson(`/runners/${segment(runnerId)}/models`, request, ModelWriteReply);

/** 200 with the stored row; `changed` false when it already was so. */
export const patchModel = (
  runnerId: string,
  modelId: string,
  request: ModelPatchRequest,
): Promise<ModelWriteReply> =>
  patchJson(
    `/runners/${segment(runnerId)}/models/${segment(modelId)}`,
    request,
    ModelWriteReply,
  );

/** Turns the model off (never deletes it); its tier goes back to the adapter's row. */
export const deactivateModel = (
  runnerId: string,
  modelId: string,
): Promise<ModelWriteReply> =>
  deleteJson(
    `/runners/${segment(runnerId)}/models/${segment(modelId)}`,
    ModelWriteReply,
  );

/**
 * `POST /runners/:id/updates/:version/dismiss`: dismisses one open update check.
 * Idempotent; a version this runner never checked is 404.
 */
export const dismissRunnerUpdate = (
  runnerId: string,
  latest: string,
): Promise<RunnerUpdateDismissed> =>
  postJson(
    `/runners/${segment(runnerId)}/updates/${segment(latest)}/dismiss`,
    {},
    RunnerUpdateDismissed,
  );
