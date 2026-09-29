import { ConformanceSummary, RunnerCaps } from "@bayon/core";
import { z } from "zod";
import { ReportDir } from "./commands.js";
import { RunnerUpdateView } from "./rest.js";

// Runners and their conformance (§12.1, §15): `GET /runners` with each runner's
// certification per (executor, model), and `POST /runners/:id/conformance`, which
// inserts runner.conformance for one model.

const epochMs = z.int().nonnegative();
const nullableText = z.string().nullable();

/** One `runner_certifications` row: the runner with one model on one executor. */
export const CertificationView = z.object({
  executor_id: z.string(),
  /** The models row it was earned on; it holds for that model alone. */
  model_id: z.string(),
  /**
   * Earned with context compression on (spec M12): it admits the sessions of a project
   * that compresses, and only those; the runner's normal badge counts the others.
   */
  compression: z.boolean().default(false),
  /** The model string the suite ran. */
  model: z.string(),
  runner_version: z.string(),
  suite_version: z.string(),
  kit_hash: z.string(),
  caps_hash: z.string(),
  report_path: nullableText,
  gate_eligible: z.boolean(),
  /** Unattended allowed on this executor: null when not, and once decertified. */
  passed_at: epochMs.nullable(),
  certified_at: epochMs,
  decertified_at: epochMs.nullable(),
  decertified_reason: nullableText,
  /** The stored result's summary; null if it cannot be read. */
  summary: ConformanceSummary.nullable(),
});
export type CertificationView = z.infer<typeof CertificationView>;

/** One of a runner's models, and the roles whose binding runs it. */
export const RunnerModelView = z.object({
  id: z.string(),
  tier: z.string(),
  model: z.string(),
  /** The roles whose binding (or fallback) runs this model, and each project step whose tier selects
   * it as `<project> · <step> step`: what `frm runner conformance` certifies by default.
   * Empty: neither names it (an agent's own profile may still). */
  bound_roles: z.array(z.string()),
  /** Who owns the row: its adapter's registration at boot, or the operator. */
  source: z.enum(["adapter", "operator"]),
  active: z.boolean(),
  effort: nullableText,
  price_in_per_mtok: z.number().nullable(),
  price_out_per_mtok: z.number().nullable(),
  price_cache_read_per_mtok: z.number().nullable(),
  price_cache_write_per_mtok: z.number().nullable(),
  context_tokens: z.int().nullable(),
  /**
   * The row's adapter settings (e.g. a provider URL): never a secret. Read-only here: they direct
   * network egress, so only `frm config apply … --yes` changes them.
   */
  settings: z.record(z.string(), z.json()),
});
export type RunnerModelView = z.infer<typeof RunnerModelView>;

/** A `runners` row with its certifications. Its own two flags: certified on at least one executor. */
export const RunnerView = z.object({
  id: z.string(),
  kind: z.string(),
  adapter: z.string(),
  version_detected: nullableText,
  enabled: z.boolean(),
  /** caps_json; null if it does not parse. */
  caps: RunnerCaps.nullable(),
  gate_eligible: z.boolean(),
  conformance_passed_at: epochMs.nullable(),
  certifications: z.array(CertificationView),
  /** Its active models, by id. */
  models: z.array(RunnerModelView),
  /** Its models turned off but not retired, by id: the operator may turn one on again. */
  inactive_models: z.array(RunnerModelView),
  /** An open update check: null when none, or once the operator dismisses it. */
  update: RunnerUpdateView.nullable(),
});
export type RunnerView = z.infer<typeof RunnerView>;

/** `GET /runners`. */
export const RunnersView = z.object({ runners: z.array(RunnerView) });
export type RunnersView = z.infer<typeof RunnersView>;

/**
 * `POST /runners/:id/conformance`. `model_id`: an active models row of that runner — the model the
 * suite runs and the certificate is for. `report_dir`: absolute, on the supervisor's host.
 */
export const RunnerConformanceRequest = z.strictObject({
  executor_id: z.string().min(1),
  model_id: z.string().min(1),
  report_dir: ReportDir.optional(),
  /**
   * Run the suite with context compression on (spec M12): test 17 as well, and the certificate is
   * the compression-on one. Refused on an executor that is not local, and by the supervisor for a
   * runner that does not compress there.
   */
  compression: z.boolean().optional(),
});
export type RunnerConformanceRequest = z.infer<typeof RunnerConformanceRequest>;

/** Its reply: the `runner.conformance` command, whose result is a RunnerConformanceResult. */
export const RunnerConformanceAccepted = z.object({
  command_id: z.string().min(1),
  created: z.boolean(),
});
export type RunnerConformanceAccepted = z.infer<
  typeof RunnerConformanceAccepted
>;

// The operator's models: `frm config apply`'s `models` rows and the REST door's bodies.

const tier = z.enum(["complex", "standard", "cheap"]);
/** USD per million tokens; 0 is a price (a local model), absent is none. */
const price = z.number().nonnegative().max(10_000);
const modelId = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    "letters, digits, . _ : - (128 at most)",
  );

/** One models row as the operator writes it. The runner's adapter judges `model` and `settings`. */
export const ModelInput = z.strictObject({
  id: modelId,
  runner_id: z.string().min(1),
  tier,
  model: z.string().min(1).max(256),
  effort: z.string().min(1).max(64).nullable().optional(),
  price_in_per_mtok: price,
  price_out_per_mtok: price,
  /** Absent: the input price. */
  price_cache_read_per_mtok: price.nullable().optional(),
  price_cache_write_per_mtok: price.nullable().optional(),
  context_tokens: z.int().positive().nullable().optional(),
  /** The adapter's own per-model settings; changing them needs `--yes` (they direct egress). */
  settings: z.record(z.string(), z.json()).optional(),
  active: z.boolean().optional(),
});
export type ModelInput = z.infer<typeof ModelInput>;

/** `POST /runners/:id/models`: a new row; the runner is the path's, and settings are shell-only. */
export const ModelCreateRequest = ModelInput.omit({
  runner_id: true,
  settings: true,
});
export type ModelCreateRequest = z.infer<typeof ModelCreateRequest>;

/** `PATCH /runners/:id/models/:model`: what the GUI edits. The model string is fixed once stored. */
export const ModelPatchRequest = z
  .strictObject({
    tier,
    effort: z.string().min(1).max(64).nullable(),
    price_in_per_mtok: price,
    price_out_per_mtok: price,
    price_cache_read_per_mtok: price,
    price_cache_write_per_mtok: price,
    context_tokens: z.int().positive().nullable(),
    active: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "change at least one field");
export type ModelPatchRequest = z.infer<typeof ModelPatchRequest>;

/** The reply to a POST, PATCH or DELETE: the row as stored, and what the write did. */
export const ModelWriteReply = z.object({
  model: RunnerModelView,
  changed: z.boolean(),
  /** Adapter rows turned off to make room in the tier. */
  replaced: z.array(z.string()),
});
export type ModelWriteReply = z.infer<typeof ModelWriteReply>;

/**
 * `POST /runners/:id/updates/:version/dismiss`: the operator dismissed one (runner,
 * latest) pair, and it stays gone. Idempotent; a version this runner never checked is not_found.
 */
export const RunnerUpdateDismissed = z.object({
  runner_id: z.string(),
  latest: z.string(),
});
export type RunnerUpdateDismissed = z.infer<typeof RunnerUpdateDismissed>;
