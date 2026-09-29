import {
  ModelCreateRequest,
  ModelPatchRequest,
  type RunnerModelView,
} from "@bayon/proto";

// The Models section's form, pure: text fields in, a request the API's own schema
// accepts out — or the first problem, named for the field. Prices are USD per million tokens; 0 is
// a price (a local model), blank is none (a cache price then defaults to the input price).

export const TIERS = ["complex", "standard", "cheap"] as const;

export interface ModelForm {
  readonly id: string;
  readonly model: string;
  readonly tier: string;
  readonly effort: string;
  readonly priceIn: string;
  readonly priceOut: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly context: string;
}

export const BLANK_FORM: ModelForm = {
  id: "",
  model: "",
  tier: "standard",
  effort: "",
  priceIn: "",
  priceOut: "",
  cacheRead: "",
  cacheWrite: "",
  context: "",
};

const text = (n: number | null): string => (n === null ? "" : String(n));

/** A stored row as the form edits it. */
export const formOf = (m: RunnerModelView): ModelForm => ({
  id: m.id,
  model: m.model,
  tier: m.tier,
  effort: m.effort ?? "",
  priceIn: text(m.price_in_per_mtok),
  priceOut: text(m.price_out_per_mtok),
  cacheRead: text(m.price_cache_read_per_mtok),
  cacheWrite: text(m.price_cache_write_per_mtok),
  context: text(m.context_tokens),
});

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

const blank = (s: string) => s.trim() === "";

/** A number the field holds, null when blank, or the problem with it. */
function numberOf(
  label: string,
  s: string,
  o: { readonly integer?: boolean } = {},
): Parsed<number | null> {
  if (blank(s)) return { ok: true, value: null };
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n < 0)
    return { ok: false, problem: `${label} must be a number, 0 or more` };
  if (o.integer === true && (!Number.isInteger(n) || n === 0))
    return { ok: false, problem: `${label} must be a whole number above 0` };
  return { ok: true, value: n };
}

interface Numbers {
  readonly price_in_per_mtok: number | null;
  readonly price_out_per_mtok: number | null;
  readonly price_cache_read_per_mtok: number | null;
  readonly price_cache_write_per_mtok: number | null;
  readonly context_tokens: number | null;
}

function numbersOf(f: ModelForm): Parsed<Numbers> {
  const fields = [
    ["price_in_per_mtok", numberOf("Input price", f.priceIn)],
    ["price_out_per_mtok", numberOf("Output price", f.priceOut)],
    ["price_cache_read_per_mtok", numberOf("Cache read price", f.cacheRead)],
    ["price_cache_write_per_mtok", numberOf("Cache write price", f.cacheWrite)],
    ["context_tokens", numberOf("Context", f.context, { integer: true })],
  ] as const;
  const values: Record<string, number | null> = {};
  for (const [key, parsed] of fields) {
    if (!parsed.ok) return parsed;
    values[key] = parsed.value;
  }
  return { ok: true, value: values as unknown as Numbers };
}

const firstIssue = (issues: readonly { readonly message: string }[]) =>
  issues[0]?.message ?? "the form is not complete";

/** POST /runners/:id/models's body. Both prices are needed: an unpriced model cannot spawn. */
export function createRequestOf(f: ModelForm): Parsed<ModelCreateRequest> {
  const n = numbersOf(f);
  if (!n.ok) return n;
  if (n.value.price_in_per_mtok === null || n.value.price_out_per_mtok === null)
    return {
      ok: false,
      problem: "Give both the input and the output price (0 is allowed)",
    };
  const parsed = ModelCreateRequest.safeParse({
    id: f.id.trim(),
    model: f.model.trim(),
    tier: f.tier,
    ...(blank(f.effort) ? {} : { effort: f.effort.trim() }),
    price_in_per_mtok: n.value.price_in_per_mtok,
    price_out_per_mtok: n.value.price_out_per_mtok,
    ...(n.value.price_cache_read_per_mtok === null
      ? {}
      : { price_cache_read_per_mtok: n.value.price_cache_read_per_mtok }),
    ...(n.value.price_cache_write_per_mtok === null
      ? {}
      : { price_cache_write_per_mtok: n.value.price_cache_write_per_mtok }),
    ...(n.value.context_tokens === null
      ? {}
      : { context_tokens: n.value.context_tokens }),
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, problem: firstIssue(parsed.error.issues) };
}

/** PATCH's body: only what changed from `stored`; a blank price stays as it is. */
export function patchRequestOf(
  f: ModelForm,
  stored: RunnerModelView,
): Parsed<ModelPatchRequest> {
  const n = numbersOf(f);
  if (!n.ok) return n;
  const effort = blank(f.effort) ? null : f.effort.trim();
  const changes: Record<string, unknown> = {
    ...(f.tier === stored.tier ? {} : { tier: f.tier }),
    ...(effort === stored.effort ? {} : { effort }),
    ...(n.value.context_tokens === stored.context_tokens
      ? {}
      : { context_tokens: n.value.context_tokens }),
  };
  for (const key of [
    "price_in_per_mtok",
    "price_out_per_mtok",
    "price_cache_read_per_mtok",
    "price_cache_write_per_mtok",
  ] as const) {
    const value = n.value[key];
    if (value !== null && value !== stored[key]) changes[key] = value;
  }
  if (Object.keys(changes).length === 0)
    return { ok: false, problem: "Nothing changed" };
  const parsed = ModelPatchRequest.safeParse(changes);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, problem: firstIssue(parsed.error.issues) };
}
