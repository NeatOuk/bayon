// Each runner's `validateModel` hook by runner id, with no adapter loaded: the light
// half of registry.ts for the API and frm, which judge an operator's models row but never spawn
// (Invariant 1: this and registry.ts are the files outside an adapter that name adapters).
import type { RunnerAdapter } from "../adapter.js";
import { validateClaudeSdkModel } from "./claude-sdk/models.js";
import {
  opencodeSettingsNote,
  validateOpencodeModel,
} from "./opencode/models.js";

export type ValidateModel = NonNullable<RunnerAdapter["validateModel"]>;

/**
 * Runners with rules of their own; every other runner takes `acceptRegisteredModels`. opencode
 * stays first: `tools/frm/src/config-models.test.ts` takes the first ruled runner and expects
 * `provider/model`.
 */
export const MODEL_VALIDATORS: ReadonlyMap<string, ValidateModel> = new Map([
  ["opencode", validateOpencodeModel],
  ["claude-sdk", validateClaudeSdkModel],
]);

/** What a model's settings open, for the operator's consent; null when nothing. */
export type SettingsNote = (
  settings: Readonly<Record<string, unknown>>,
) => string | null;

/** Runners whose model settings reach the network, by id. */
export const SETTINGS_NOTES: ReadonlyMap<string, SettingsNote> = new Map([
  ["opencode", opencodeSettingsNote],
]);
