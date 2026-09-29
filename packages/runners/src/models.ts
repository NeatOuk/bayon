// `@bayon/runners/models`: judge an operator's models row by its runner's own rules,
// without loading the adapter — pure, no process, no SDK. The API and frm call this; the adapter
// object's `validateModel` is the same function.
import {
  canonicalJson,
  err,
  ok,
  type JsonValue,
  type Result,
} from "@bayon/core";
import type { ModelContext, ModelProposal, ModelTier } from "./adapter.js";
import {
  MODEL_VALIDATORS,
  SETTINGS_NOTES,
} from "./adapters/registry-models.js";
import { acceptRegisteredModels } from "./model-check.js";
import { frmError } from "./errors.js";

export type { ModelContext, ModelProposal, ModelTier } from "./adapter.js";
export {
  BAYON_DEFAULT_PORTS,
  acceptRegisteredModels,
  reservedPortsFrom,
} from "./model-check.js";

/** The runners whose adapters judge models by rules of their own, not the registered default. */
export const runnersWithModelRules = (): readonly string[] => [
  ...MODEL_VALIDATORS.keys(),
];

/** What `runnerId`'s model settings would open, in its adapter's words; null when nothing. */
export const settingsNoteFor = (
  runnerId: string,
  settings: Readonly<Record<string, unknown>>,
): string | null => SETTINGS_NOTES.get(runnerId)?.(settings) ?? null;

/** `runnerId`'s verdict on `row`: its adapter's hook, else the registered-models default. */
export function validateModelFor(
  runnerId: string,
  row: ModelProposal,
  ctx: ModelContext,
): Result<void> {
  return (MODEL_VALIDATORS.get(runnerId) ?? acceptRegisteredModels)(row, ctx);
}

/** An operator's models row as a config file or the REST door gives it (proto's ModelInput). */
export interface OperatorModelInput {
  readonly id: string;
  readonly runner_id: string;
  readonly tier: ModelTier;
  readonly model: string;
  readonly effort?: string | null | undefined;
  readonly price_in_per_mtok: number;
  readonly price_out_per_mtok: number;
  readonly price_cache_read_per_mtok?: number | null | undefined;
  readonly price_cache_write_per_mtok?: number | null | undefined;
  readonly context_tokens?: number | null | undefined;
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
  readonly active?: boolean | undefined;
}

/** The row to write, every column filled: @bayon/db's OperatorModel, structurally. */
export interface CheckedOperatorModel {
  readonly id: string;
  readonly runner_id: string;
  readonly tier: ModelTier;
  readonly model: string;
  readonly effort: string | null;
  readonly price_in_per_mtok: number;
  readonly price_out_per_mtok: number;
  readonly price_cache_read_per_mtok: number;
  readonly price_cache_write_per_mtok: number;
  readonly context_tokens: number | null;
  readonly settings_json: string;
  readonly active: boolean;
}

/** The stored runner row and what its adapter registered, which a model is judged against. */
export interface StoredRunner {
  readonly id: string;
  readonly defaults_json: string;
  /** The model strings of its adapter rows still registered (source 'adapter', not retired). */
  readonly registered: readonly string[];
  /** The ports Bayon's own API and GUI listen on (`reservedPortsFrom`); default the usual ones. */
  readonly reservedPorts?: readonly number[];
}

const invalid = (message: string): Result<never> =>
  err(frmError("validation", message));

/**
 * One operator model, judged by its runner's adapter and filled in: a cache price left out is the
 * input price (a cached token never costs more than a fresh one, so the budget is never
 * under-counted), effort null, settings `{}` stored as canonical JSON, active unless false.
 */
export function checkOperatorModel(
  input: OperatorModelInput,
  runner: StoredRunner,
): Result<CheckedOperatorModel> {
  if (input.runner_id !== runner.id)
    return invalid(
      `model ${input.id} names runner ${input.runner_id}, not ${runner.id}`,
    );
  let defaults: unknown;
  try {
    defaults = JSON.parse(runner.defaults_json) as unknown;
  } catch {
    defaults = undefined;
  }
  if (
    typeof defaults !== "object" ||
    defaults === null ||
    Array.isArray(defaults)
  )
    return invalid(`runner ${runner.id}'s defaults_json is not a JSON object`);
  const settings = input.settings ?? {};
  const effort = input.effort ?? null;
  const contextTokens = input.context_tokens ?? null;
  const verdict = validateModelFor(
    runner.id,
    {
      id: input.id,
      tier: input.tier,
      model: input.model,
      ...(effort === null ? {} : { effort }),
      settings,
      ...(contextTokens === null ? {} : { contextTokens }),
    },
    {
      defaults: defaults as Record<string, unknown>,
      registered: runner.registered,
      ...(runner.reservedPorts === undefined
        ? {}
        : { reservedPorts: runner.reservedPorts }),
    },
  );
  if (!verdict.ok)
    return invalid(
      `model ${input.id} (runner ${runner.id}): ${verdict.error.message}`,
    );
  return ok({
    id: input.id,
    runner_id: runner.id,
    tier: input.tier,
    model: input.model,
    effort,
    price_in_per_mtok: input.price_in_per_mtok,
    price_out_per_mtok: input.price_out_per_mtok,
    price_cache_read_per_mtok:
      input.price_cache_read_per_mtok ?? input.price_in_per_mtok,
    price_cache_write_per_mtok:
      input.price_cache_write_per_mtok ?? input.price_in_per_mtok,
    context_tokens: input.context_tokens ?? null,
    settings_json: canonicalJson(settings as JsonValue),
    active: input.active ?? true,
  });
}
