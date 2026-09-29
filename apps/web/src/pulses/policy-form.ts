import {
  PulsePolicyPatch,
  type PulseMode,
  type PulsePolicy,
} from "@bayon/proto";
import { z } from "zod";

// The pulse-policy editor's form: the policy in an operator's units (minutes, seconds), and back to
// the PATCH body of the fields that changed (§12.1 PATCH /agents/:id/pulse-policy).

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

export type PolicyField =
  "interval_ms" | "debounce_ms" | "min_gap_ms" | "max_per_hour" | "jitter_pct";

/** A stored value is the shown one times its unit. */
const UNITS: Readonly<Record<PolicyField, number>> = {
  interval_ms: MINUTE,
  debounce_ms: SECOND,
  min_gap_ms: MINUTE,
  max_per_hour: 1,
  jitter_pct: 1,
};

export const POLICY_FIELDS: readonly {
  readonly key: PolicyField;
  readonly label: string;
}[] = [
  { key: "interval_ms", label: "Interval (minutes)" },
  { key: "debounce_ms", label: "Debounce (seconds)" },
  { key: "min_gap_ms", label: "Minimum gap (minutes)" },
  { key: "max_per_hour", label: "Most per hour" },
  { key: "jitter_pct", label: "Jitter (%)" },
];

export interface PolicyDraft {
  readonly mode: PulseMode;
  readonly values: Readonly<Record<PolicyField, string>>;
}

const shown = (policy: PulsePolicy, key: PolicyField): string =>
  String(policy[key] / UNITS[key]);

export const draftOf = (policy: PulsePolicy): PolicyDraft => ({
  mode: policy.mode,
  values: {
    interval_ms: shown(policy, "interval_ms"),
    debounce_ms: shown(policy, "debounce_ms"),
    min_gap_ms: shown(policy, "min_gap_ms"),
    max_per_hour: shown(policy, "max_per_hour"),
    jitter_pct: shown(policy, "jitter_pct"),
  },
});

/** A shown value back to the stored integer; null when it is not a number. */
function stored(raw: string, key: PolicyField): number | null {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  return trimmed === "" || !Number.isFinite(value)
    ? null
    : Math.round(value * UNITS[key]);
}

export type PolicyPatchResult =
  | { readonly ok: true; readonly patch: PulsePolicyPatch }
  | { readonly ok: false; readonly message: string };

/** The PATCH body of what the draft changes, checked with the server's own schema. */
export function patchOf(
  policy: PulsePolicy,
  draft: PolicyDraft,
): PolicyPatchResult {
  const values = POLICY_FIELDS.map((field) => ({
    field,
    value: stored(draft.values[field.key], field.key),
  }));
  const blank = values.find(({ value }) => value === null);
  if (blank !== undefined)
    return { ok: false, message: `${blank.field.label}: enter a number.` };
  const entries: readonly (readonly [string, unknown])[] = [
    ...(draft.mode === policy.mode ? [] : [["mode", draft.mode] as const]),
    ...values
      .filter(({ field, value }) => value !== policy[field.key])
      .map(({ field, value }) => [field.key, value] as const),
  ];
  if (entries.length === 0) return { ok: false, message: "Nothing changed." };
  const parsed = PulsePolicyPatch.safeParse(Object.fromEntries(entries));
  return parsed.success
    ? { ok: true, patch: parsed.data }
    : { ok: false, message: z.prettifyError(parsed.error) };
}
