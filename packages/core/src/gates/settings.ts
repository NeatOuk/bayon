import { z } from "zod";
import { err, ok, type Result } from "../errors.js";
import { WorkRole } from "../roles.js";
import { FindingSeverity } from "./schemas.js";

// The gate settings 007 seeds (M3 contracts), read through getSettings. A missing row is a config
// error, never a silent default (§4: config over code).

/** A review whose base moved under it: fail the gate, or pass it with `flags.base_drift`. */
export const BaseDriftPolicy = z.enum(["fail", "warn"]);
export type BaseDriftPolicy = z.infer<typeof BaseDriftPolicy>;

export const GateSettings = z.object({
  wall_clock_ms: z.int().positive(),
  /** Only open findings at these severities block a transition. */
  blocking_severities: z.array(FindingSeverity),
  base_drift: BaseDriftPolicy,
  /** How many times a gate that timed out or met a supervisor restart is retried. */
  timeout_retries: z.int().nonnegative(),
  /**
   * Whether `parity_check` is in force (§10.3; 020 seeds it `false`). Off: no review
   * round opens it and `pass_review` does not ask for it. On: both, for a workspace whose kind is
   * not `single`. One switch decides both halves, so a multi-repo ticket can never be held by a
   * gate no round opened — which is what would happen if the two were configured apart.
   */
  parity_check: z.boolean(),
  /**
   * Whether `lint_check` is in force (024 seeds it `false`). Off: no review round opens
   * it and `pass_review` does not ask for it. On: both, for a ticket whose workspace declares a
   * `repos.lint_cmd` — the second half of the fact, without which flipping this switch on a fleet
   * that has configured no lint command would stall every ticket behind a job with nothing to run.
   * One switch decides both halves, as `parity_check`'s does, so a round and an edge cannot
   * disagree about the gate.
   */
  lint_check: z.boolean(),
  /**
   * How many review rounds running may fail `base_drift` before `reviewStep` stops sending the
   * ticket back to fix and leaves it to the operator (052 seeds 3). Bounds the paid
   * fix sessions a base that keeps moving, or a fixer that never merges it, would otherwise loop.
   */
  drift_rounds_max: z.int().positive(),
});
export type GateSettings = z.infer<typeof GateSettings>;

/** The settings key of each GateSettings field. */
export const GATE_SETTING_KEYS = {
  wall_clock_ms: "gates.wall_clock_ms",
  blocking_severities: "gates.blocking_severities",
  base_drift: "gates.base_drift",
  timeout_retries: "gates.timeout_retries",
  parity_check: "gates.parity_check",
  lint_check: "gates.lint_check",
  drift_rounds_max: "gates.drift_rounds_max",
} as const satisfies Record<keyof GateSettings, string>;

/** The roles that need a trust='untrusted' executor (trust rule, M3). */
export const UNTRUSTED_ROLES_KEY = "executors.untrusted_roles";
/**
 * Work roles, never bare strings: `trustRefusal` matches the spawn's role against this list
 * exactly, so `"REVIEWER"` or `" builder "` would not loosen the isolation boundary but silently
 * empty it — a role admitted onto the trusted host with no refusal logged, under a setting that
 * still reads as a plausible list. Every door that writes the setting checks this schema
 * (`checkSeededSetting`), so there is one place to get it right.
 */
export const UntrustedRoles = z.array(WorkRole);
export type UntrustedRoles = z.infer<typeof UntrustedRoles>;

/** GateSettings from the parsed settings rows (getSettings' map). */
export function readGateSettings(
  rows: ReadonlyMap<string, unknown>,
): Result<GateSettings> {
  const parsed = GateSettings.safeParse({
    wall_clock_ms: rows.get(GATE_SETTING_KEYS.wall_clock_ms),
    blocking_severities: rows.get(GATE_SETTING_KEYS.blocking_severities),
    base_drift: rows.get(GATE_SETTING_KEYS.base_drift),
    timeout_retries: rows.get(GATE_SETTING_KEYS.timeout_retries),
    parity_check: rows.get(GATE_SETTING_KEYS.parity_check),
    lint_check: rows.get(GATE_SETTING_KEYS.lint_check),
    drift_rounds_max: rows.get(GATE_SETTING_KEYS.drift_rounds_max),
  });
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `gate settings: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}
