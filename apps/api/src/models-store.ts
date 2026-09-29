import { err, ok, type Result } from "@bayon/core";
import {
  agentBoundModels,
  getModel,
  getRunner,
  listBoundModels,
  listModels,
  type BoundModel,
  type Db,
  type ModelRow,
} from "@bayon/db";
import {
  deactivateOperatorModel,
  putOperatorModel,
  type ModelPut,
} from "@bayon/db/api";
import type { ModelWriteReply, RunnerModelView } from "@bayon/proto";
import {
  checkOperatorModel,
  reservedPortsFrom,
  type OperatorModelInput,
} from "@bayon/runners/models";
import { z } from "zod";
import type { ApiStore } from "./store.js";

// The operator's models over REST: POST, PATCH and DELETE /runners/:id/models. Each row
// is judged by its runner's own adapter (validateModel, through @bayon/runners/models: pure, no
// adapter loaded) against the runner row the supervisor registered; the tier rule and the audit
// are the writer's (@bayon/db/api). Settings are never taken here: they direct network egress, so
// the GUI shows them and `frm config apply … --yes` changes them. A PATCH keeps the stored ones.

export type ModelsStore = Pick<
  ApiStore,
  "createModel" | "patchModel" | "deactivateModel"
>;

const Settings = z.record(z.string(), z.json());
type Settings = z.infer<typeof Settings>;

/** A stored row's settings; `{}` when they do not parse (never an error for the page). */
export function storedSettings(json: string): Settings {
  try {
    const parsed = Settings.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Who runs a model: a role binding, a project's step tier, or an enabled agent. */
export type ModelUse = Pick<BoundModel, "role" | "model_id">;

/**
 * Every use of every model, as GET /runners' bound_roles lists them: the role bindings' and step
 * tiers' (listBoundModels), then each enabled agent's own (agentBoundModels) — a new project's agents
 * run their profile's tier with neither, and that is the model they need certified.
 */
export async function modelUses(db: Db): Promise<Result<ModelUse[]>> {
  const bound = await listBoundModels(db);
  if (!bound.ok) return bound;
  const agents = await agentBoundModels(db);
  if (!agents.ok) return agents;
  return ok([...bound.value, ...agents.value]);
}

/** One models row as GET /runners shows it, with who runs it. */
export const modelView = (
  m: ModelRow,
  bound: readonly ModelUse[],
): RunnerModelView => ({
  id: m.id,
  tier: m.tier,
  model: m.model,
  bound_roles: [
    ...new Set(bound.filter((b) => b.model_id === m.id).map((b) => b.role)),
  ],
  source: m.source,
  active: m.active === 1,
  effort: m.effort,
  price_in_per_mtok: m.price_in_per_mtok,
  price_out_per_mtok: m.price_out_per_mtok,
  price_cache_read_per_mtok: m.price_cache_read_per_mtok,
  price_cache_write_per_mtok: m.price_cache_write_per_mtok,
  context_tokens: m.context_tokens,
  settings: storedSettings(m.settings_json),
});

const refuse = (cls: "validation" | "not_found", message: string) =>
  err({ class: cls, message, retryable: false });

/** The input judged by the runner's adapter against the runner as registered, then written. */
async function judgedWrite(
  db: Db,
  input: OperatorModelInput,
  mode: "create" | "upsert",
): Promise<Result<ModelWriteReply>> {
  const runner = await getRunner(db, input.runner_id);
  if (!runner.ok) return runner;
  const models = await listModels(db);
  if (!models.ok) return models;
  // What the adapter registers, and the row's own string: fixed once stored, it was judged when
  // first written — an adapter row the operator took over is no longer an adapter row.
  const registered = models.value
    .filter(
      (m) =>
        m.runner_id === input.runner_id &&
        ((m.source === "adapter" && m.retired_at === null) ||
          m.id === input.id),
    )
    .map((m) => m.model);
  const checked = checkOperatorModel(input, {
    id: runner.value.id,
    defaults_json: runner.value.defaults_json,
    registered,
    // The ports this API and the GUI listen on, read as they read them (FRM_API_PORT, FRM_WEB_PORT).
    reservedPorts: reservedPortsFrom(process.env),
  });
  if (!checked.ok) return checked;
  const put = await putOperatorModel(db, checked.value, { via: "rest", mode });
  return put.ok ? reply(db, input.id, put.value) : put;
}

/** The row as stored after a write, with what the write did. */
async function reply(
  db: Db,
  id: string,
  put: ModelPut,
): Promise<Result<ModelWriteReply>> {
  const row = await getModel(db, id);
  if (!row.ok) return row;
  const bound = await modelUses(db);
  if (!bound.ok) return bound;
  return ok({
    model: modelView(row.value, bound.value),
    changed: put.changed,
    replaced: [...put.replaced],
  });
}

/** `runnerId`'s model `modelId`, or `not_found` naming both. */
async function ownModel(
  db: Db,
  runnerId: string,
  modelId: string,
): Promise<Result<ModelRow>> {
  const row = await getModel(db, modelId);
  if (!row.ok || row.value.runner_id !== runnerId) {
    return !row.ok && row.error.class !== "not_found"
      ? row
      : refuse("not_found", `runner ${runnerId} has no model ${modelId}`);
  }
  return row;
}

export function modelsStore(db: Db): ModelsStore {
  return {
    createModel(runnerId, body) {
      return judgedWrite(db, { ...body, runner_id: runnerId }, "create");
    },
    async patchModel(runnerId, modelId, body) {
      const stored = await ownModel(db, runnerId, modelId);
      if (!stored.ok) return stored;
      const s = stored.value;
      const input: OperatorModelInput = {
        id: s.id,
        runner_id: runnerId,
        tier: body.tier ?? s.tier,
        model: s.model,
        effort: body.effort === undefined ? s.effort : body.effort,
        price_in_per_mtok: body.price_in_per_mtok ?? s.price_in_per_mtok ?? 0,
        price_out_per_mtok:
          body.price_out_per_mtok ?? s.price_out_per_mtok ?? 0,
        price_cache_read_per_mtok:
          body.price_cache_read_per_mtok ?? s.price_cache_read_per_mtok,
        price_cache_write_per_mtok:
          body.price_cache_write_per_mtok ?? s.price_cache_write_per_mtok,
        context_tokens:
          body.context_tokens === undefined
            ? s.context_tokens
            : body.context_tokens,
        settings: storedSettings(s.settings_json),
        active: body.active ?? s.active === 1,
      };
      if (
        (s.price_in_per_mtok === null &&
          body.price_in_per_mtok === undefined) ||
        (s.price_out_per_mtok === null && body.price_out_per_mtok === undefined)
      )
        return refuse(
          "validation",
          `model ${modelId} is unpriced: give price_in_per_mtok and price_out_per_mtok (0 is allowed)`,
        );
      return judgedWrite(db, input, "upsert");
    },
    async deactivateModel(runnerId, modelId) {
      const done = await deactivateOperatorModel(db, runnerId, modelId, "rest");
      return done.ok
        ? reply(db, modelId, { changed: done.value.changed, replaced: [] })
        : done;
    },
  };
}
