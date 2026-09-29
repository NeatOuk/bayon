import {
  OPERATOR_SETTINGS,
  OperatorSettingsPatch,
  operatorSettingSchema,
  type OperatorSettingDef,
  type OperatorSettingKey,
} from "@bayon/core";
import type { OperatorSettingView } from "@bayon/proto";

// Settings → General's form, as plain data: what the inputs hold, and the patch of the
// keys that changed, each checked with core's whitelist schema before it is ever sent.

/** Each key's input text; a flag holds "1" or "0". */
export type Draft = Readonly<Partial<Record<OperatorSettingKey, string>>>;

export type FieldErrors = Readonly<Partial<Record<OperatorSettingKey, string>>>;

export type Checked =
  | { readonly ok: true; readonly patch: OperatorSettingsPatch | null }
  | { readonly ok: false; readonly errors: FieldErrors };

const textOf = (value: number | null): string =>
  value === null ? "" : String(value);

/** The inputs as the server has them. */
export const draftOf = (settings: readonly OperatorSettingView[]): Draft =>
  Object.fromEntries(settings.map((s) => [s.key, textOf(s.value)]));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A duration in ms as a person reads it: 5 s, 30 min, 1 h, 1 h 30 min. */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < MINUTE) return `${Number((ms / 1_000).toFixed(1))} s`;
  if (ms < HOUR) return `${Number((ms / MINUTE).toFixed(1))} min`;
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.round((ms % HOUR) / MINUTE);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** What a field asks for when its value is refused. */
export function expected(def: OperatorSettingDef): string {
  const unit = def.unit === "ms" ? " ms" : def.unit === "percent" ? " %" : "";
  const off = def.offAtZero === true ? ", or 0 for off" : "";
  return `Enter ${def.int ? "a whole number" : "a number"} from ${def.min} to ${def.max}${unit}${off}.`;
}

/**
 * The patch of every changed key, or the refused fields. A key whose text is what the server has
 * is not sent; an empty field or a value outside the whitelist's bounds is refused here, never PUT.
 * `patch` is null when nothing changed.
 */
export function checkDraft(
  draft: Draft,
  settings: readonly OperatorSettingView[],
): Checked {
  const errors: Partial<Record<OperatorSettingKey, string>> = {};
  const patch: Partial<Record<OperatorSettingKey, number>> = {};
  for (const s of settings) {
    const raw = (draft[s.key] ?? textOf(s.value)).trim();
    if (raw === textOf(s.value)) continue;
    const def = OPERATOR_SETTINGS[s.key];
    const parsed = operatorSettingSchema(def).safeParse(
      raw === "" ? Number.NaN : Number(raw),
    );
    if (parsed.success) patch[s.key] = parsed.data;
    else errors[s.key] = raw === "" ? "Enter a value." : expected(def);
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (Object.keys(patch).length === 0) return { ok: true, patch: null };
  // The PUT body's own schema, the one the API parses: the last gate before it is sent.
  const body = OperatorSettingsPatch.safeParse(patch);
  return body.success
    ? { ok: true, patch: body.data }
    : { ok: false, errors: {} };
}
