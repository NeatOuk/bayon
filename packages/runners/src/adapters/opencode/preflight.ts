// opencode's model pre-flight: asks the provider a session of the model would call
// whether it serves the model, before a conformance run and at spawn. The provider is resolved as
// spawn resolves it (the runner's provider block, the model's own provider_url, the env's address).
// Providers here are keyless, so one unauthenticated GET: the OpenAI-compatible `<base>/models`,
// else Ollama's own `<origin>/api/tags`. Only on a local executor, whose network the supervisor
// shares; elsewhere it is unchecked.
import { z } from "zod";
import type { Fetch, ModelPreflight, PreflightTarget } from "../../adapter.js";
import { ProviderBlock, baseUrlOf, parseModel } from "./home.js";
import { blockFor, parseModelSettings } from "./models.js";
import { DEFAULTS } from "./registration.js";

/** How much of what the provider does serve a `not_served` reason lists. */
const LISTED_CHARS = 100;

const Providers = z
  .record(z.string().min(1), ProviderBlock)
  .default(
    () => structuredClone(DEFAULTS.providers) as Record<string, ProviderBlock>,
  );

/** The OpenAI-compatible list: `{ data: [{ id }] }`. */
const OpenAiList = z.object({
  data: z.array(z.looseObject({ id: z.string() })),
});
/** Ollama's own list: `{ models: [{ name, model? }] }`. */
const TagList = z.object({
  models: z.array(
    z.looseObject({ name: z.string(), model: z.string().optional() }),
  ),
});

type Listed =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly why: string };

const messageOf = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  return cause instanceof Error ? `${e.message} (${cause.message})` : e.message;
};

/**
 * One list request. `label` is what a reason names: the request's suffix alone, never the base
 * URL's path, which may carry a token (a gateway's `/<key>/v1`).
 */
async function list(
  url: URL,
  label: string,
  parse: (body: unknown) => readonly string[] | null,
  io: { readonly fetch: Fetch; readonly signal: AbortSignal },
): Promise<Listed> {
  let res: Response;
  try {
    res = await io.fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: io.signal,
      headers: { accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, why: `${label}: ${messageOf(e)}` };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, why: `${label} answered HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, why: `${label} answered no JSON` };
  }
  const ids = parse(body);
  return ids === null
    ? { ok: false, why: `${label} answered no model list` }
    : { ok: true, ids };
}

const openAiIds = (body: unknown): readonly string[] | null => {
  const parsed = OpenAiList.safeParse(body);
  return parsed.success ? parsed.data.data.map((m) => m.id) : null;
};

const tagIds = (body: unknown): readonly string[] | null => {
  const parsed = TagList.safeParse(body);
  return parsed.success
    ? parsed.data.models.flatMap((m) =>
        m.model === undefined || m.model === m.name
          ? [m.name]
          : [m.name, m.model],
      )
    : null;
};

/** The id as the provider lists it: exactly, or `:latest` for an id with no tag. */
const serves = (ids: readonly string[], id: string): boolean =>
  ids.includes(id) || (!id.includes(":") && ids.includes(`${id}:latest`));

/** Some of what the provider serves, cut at LISTED_CHARS. */
function listed(ids: readonly string[]): string {
  const shown: string[] = [];
  let length = 0;
  for (const id of ids) {
    if (length + id.length > LISTED_CHARS) break;
    shown.push(id);
    length += id.length + 2;
  }
  const rest = ids.length - shown.length;
  if (ids.length === 0) return "nothing";
  return rest === 0 ? shown.join(", ") : `${shown.join(", ")}, … +${rest} more`;
}

/** The provider's base URL for this target, without credentials, or why there is none. */
function baseOf(
  target: PreflightTarget,
  provider: string,
): { readonly url: URL } | { readonly why: string } {
  const providers = Providers.safeParse(target.flags["providers"]);
  if (!providers.success) return { why: "the runner's providers do not parse" };
  const block = providers.data[provider];
  if (block === undefined) return { why: `no provider block for ${provider}` };
  const settings = parseModelSettings(target.modelSettings);
  if (!settings.ok) return { why: settings.error.message };
  const text = baseUrlOf(blockFor(block, settings.value), target.env);
  if (text === undefined || text === "") {
    return {
      why: `no base URL resolves for provider ${provider} of model ${target.model}`,
    };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { why: `provider ${provider}'s base URL is not a URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { why: `provider ${provider}'s base URL is not http(s)` };
  }
  // Providers are keyless here: whatever userinfo a URL carries is never sent nor reported.
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return { url };
}

export async function preflightOpencodeModel(
  target: PreflightTarget,
  io: { readonly fetch: Fetch; readonly signal: AbortSignal },
): Promise<ModelPreflight> {
  const model = parseModel(target.model);
  if (!model.ok) return { verdict: "unchecked", reason: model.error.message };
  const { provider, id } = model.value;
  if (target.executorKind !== "local") {
    return {
      verdict: "unchecked",
      reason: `a ${target.executorKind} executor's network is not the supervisor's: model ${id} is not pre-flighted there`,
    };
  }
  const base = baseOf(target, provider);
  if ("why" in base) return { verdict: "unchecked", reason: base.why };
  const host = base.url.host;
  const path = base.url.pathname.replace(/\/+$/, "");
  // Copies of the base with only the path set: a base path that starts with `//` stays a path on
  // this host, never an authority (as resolving a relative reference would make it).
  const models = new URL(base.url);
  models.pathname = `${path}/models`;
  const tags = new URL(base.url);
  tags.pathname = "/api/tags";
  let got = await list(models, "/models", openAiIds, io);
  const whys: string[] = [];
  if (!got.ok) {
    whys.push(got.why);
    if (!io.signal.aborted) {
      got = await list(tags, "/api/tags", tagIds, io);
      if (!got.ok) whys.push(got.why);
    }
  }
  if (!got.ok) {
    return {
      verdict: "unreachable",
      reason: `cannot ask ${host} which models it serves: ${whys.join("; ")}`,
    };
  }
  return serves(got.ids, id)
    ? { verdict: "served" }
    : {
        verdict: "not_served",
        reason: `model ${id} not served by ${host} (it serves: ${listed(got.ids)})`,
      };
}
