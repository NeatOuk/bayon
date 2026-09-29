import {
  ConformanceSummary,
  RunnerCaps,
  containerRefusal,
  disabledExecutorRefusal,
  err,
  isAgentRunner,
  ok,
  type Result,
} from "@bayon/core";
import {
  getExecutor,
  getModel,
  getRunner,
  listModels,
  listRunnerCertifications,
  listRunners,
  openRunnerUpdates,
  type Db,
  type ModelRow,
  type OpenRunnerUpdate,
  type RunnerCertificationRow,
} from "@bayon/db";
import { dismissRunnerUpdate as dismissRunnerUpdateRow } from "@bayon/db/api";
import {
  RunnerUpdateDismissed,
  RunnersView,
  type CertificationView,
  type RunnerUpdateView,
} from "@bayon/proto";
import { z } from "zod";
import { parseAs } from "./dto.js";
import { modelUses, modelView, type ModelUse } from "./models-store.js";
import type { ApiStore } from "./store.js";

// The runners half of the ApiStore: runners and their certification per (executor,
// model), as the supervisor wrote them, and each runner's active models with the roles
// bound to them. The API writes neither table; it only inserts runner.conformance.

export type RunnersStore = Pick<
  ApiStore,
  "runners" | "conformanceTarget" | "dismissRunnerUpdate"
>;

const OPERATOR_ACTOR = "operator";

const StoredResult = z.object({ summary: ConformanceSummary });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // containerRefusal then finds no container facts
  }
}

/** A JSON column through `schema`; null when it does not parse, never an error for the page. */
function parsed<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const certificationView = (c: RunnerCertificationRow): CertificationView => ({
  executor_id: c.executor_id,
  model_id: c.model_id,
  compression: c.compression === 1,
  model: c.model,
  runner_version: c.runner_version,
  suite_version: c.suite_version,
  kit_hash: c.kit_hash,
  caps_hash: c.caps_hash,
  report_path: c.report_path,
  gate_eligible: c.gate_eligible === 1,
  passed_at: c.passed_at,
  certified_at: c.certified_at,
  decertified_at: c.decertified_at,
  decertified_reason: c.decertified_reason,
  summary: parsed(StoredResult, c.result_json)?.summary ?? null,
});

const runnerUpdateView = (u: OpenRunnerUpdate): RunnerUpdateView => ({
  runner_id: u.runner_id,
  current: u.current,
  latest: u.latest,
  notes_url: u.notes_url,
  found_at: u.found_at,
});

/** A runner's non-retired models, each with the roles whose binding runs it. */
const modelViews = (
  models: readonly ModelRow[],
  bound: readonly ModelUse[],
  runnerId: string,
  active: boolean,
) =>
  models
    .filter(
      (m) =>
        m.runner_id === runnerId &&
        m.retired_at === null &&
        (m.active === 1) === active,
    )
    .map((m) => modelView(m, bound));

/** The suite may run only an active model of the runner it certifies. */
async function modelOf(
  db: Db,
  runnerId: string,
  modelId: string,
): Promise<Result<ModelRow>> {
  const model = await getModel(db, modelId);
  const refuse = (why: string) =>
    err({
      class: "validation" as const,
      message: `model ${modelId} ${why}: pick one of the models the Runners page lists for ${runnerId}`,
      retryable: false,
    });
  if (!model.ok) {
    return model.error.class === "not_found" ? refuse("does not exist") : model;
  }
  if (model.value.runner_id !== runnerId) {
    return refuse(`is runner ${model.value.runner_id}'s, not ${runnerId}'s`);
  }
  return model.value.active === 1 ? ok(model.value) : refuse("is retired");
}

export function runnersStore(db: Db): RunnersStore {
  return {
    async runners() {
      const runners = await listRunners(db);
      if (!runners.ok) return runners;
      const certs = await listRunnerCertifications(db);
      if (!certs.ok) return certs;
      const models = await listModels(db);
      if (!models.ok) return models;
      const bound = await modelUses(db);
      if (!bound.ok) return bound;
      const updates = await openRunnerUpdates(db);
      if (!updates.ok) return updates;
      return parseAs(
        RunnersView,
        {
          runners: runners.value.map((r) => ({
            id: r.id,
            kind: r.kind,
            adapter: r.adapter,
            version_detected: r.version_detected,
            enabled: r.enabled === 1,
            caps: parsed(RunnerCaps, r.caps_json),
            gate_eligible: r.gate_eligible === 1,
            conformance_passed_at: r.conformance_passed_at,
            certifications: certs.value
              .filter((c) => c.runner_id === r.id)
              .map(certificationView),
            models: modelViews(models.value, bound.value, r.id, true),
            inactive_models: modelViews(models.value, bound.value, r.id, false),
            update:
              updates.value
                .filter((u) => u.runner_id === r.id)
                .map(runnerUpdateView)[0] ?? null,
          })),
        },
        "runners",
      );
    },
    // A runner that cannot run in a container is refused on one here, before any command
    //: the rule reads the defaults its adapter declares (Invariant 1).
    //
    // A disabled executor is refused here too: the operator gets the cause in the
    // response instead of a command that queues, is claimed minutes later and fails where only the
    // log sees it. This is not the last word — the executor can be disabled between this insert
    // and the supervisor's claim, so the supervisor checks the row again before it runs anything.
    async conformanceTarget(runnerId, executorId, modelId, compression) {
      const runner = await getRunner(db, runnerId);
      if (!runner.ok) return runner;
      // A job runner is the supervisor's own fixed program: the suite judges an agent.
      if (!isAgentRunner(runner.value)) {
        return err({
          class: "validation",
          message: `runner ${runnerId} is one of the supervisor's own jobs, not an agent runner: there is nothing to certify`,
          retryable: false,
        });
      }
      const model = await modelOf(db, runnerId, modelId);
      if (!model.ok) return model;
      const executor = await getExecutor(db, executorId);
      if (!executor.ok) return executor;
      const disabled = disabledExecutorRefusal({
        executorId,
        enabled: executor.value.enabled === 1,
      });
      if (disabled !== null) return err(disabled);
      // Runner-neutral (spec M12): the context proxy runs beside the supervisor, so only a local
      // executor can compress; whether this runner does is its adapter's, which the supervisor asks.
      if (compression === true && executor.value.kind !== "local") {
        return err({
          class: "validation",
          message: `executor ${executorId} is a ${executor.value.kind} executor: context compression runs on a local executor only, so there is nothing to certify with it here`,
          retryable: false,
        });
      }
      const refusal = containerRefusal({
        runnerId,
        defaults: parseJson(runner.value.defaults_json),
        executorId,
        executorKind: executor.value.kind,
      });
      return refusal === null ? ok(undefined) : err(refusal);
    },
    // `POST /runners/:id/updates/:version/dismiss`: idempotent, audited; a version this
    // runner never checked is not_found.
    async dismissRunnerUpdate(runnerId, latest) {
      const dismissed = await dismissRunnerUpdateRow(
        db,
        runnerId,
        latest,
        OPERATOR_ACTOR,
      );
      return dismissed.ok
        ? parseAs(
            RunnerUpdateDismissed,
            dismissed.value,
            `runner update ${runnerId}/${latest}`,
          )
        : dismissed;
    },
  };
}
