// What an opencode models row may be: the `validateModel` hook, pure. A model is
// `provider/model` for a provider the runner's config can serve — keyless only (// §4) — and its one setting, `provider_url`, is that provider's base URL for this model alone, in
// place of the runner's (`{env:OLLAMA_BASE_URL}` by default). The URL is not a secret: an address
// on the operator's network, which the Seatbelt profile opens by its port (confine.ts). On a
// container executor its host must be in the executor's egressHosts; no image installs opencode
// yet (DEFAULTS.containerUnready), so that is documented, not enforced here.
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import type { ModelContext, ModelProposal } from "../../adapter.js";
import { frmError } from "../../errors.js";
import { BAYON_DEFAULT_PORTS } from "../../model-check.js";
import { ProviderBlock, parseModel } from "./home.js";
import { DEFAULTS, RUNNER_ID } from "./registration.js";

/** The port a URL reaches: its own, else its scheme's. */
const portOfUrl = (url: URL): number =>
  url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);

/**
 * Link-local addresses, where cloud metadata services answer (169.254.0.0/16, fe80::/10, and
 * IPv4-mapped 169.254 in IPv6). URL has already normalised the host (decimal, hex and short IPv4
 * forms become dotted quads; IPv6 is lower-case and compressed).
 */
function linkLocal(hostname: string): boolean {
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (!hostname.startsWith("[")) return false;
  const v6 = hostname.slice(1, -1).toLowerCase();
  if (/^::ffff:(169\.254\.|a9fe:)/.test(v6)) return true;
  const first = v6.split(":")[0] ?? "";
  const hextet = first === "" ? 0 : Number.parseInt(first, 16);
  return (hextet & 0xffc0) === 0xfe80;
}

/**
 * Why a provider URL is refused, or null: http(s), a host, no credentials, no query or fragment;
 * not link-local (a metadata service); and not on a port Bayon's own API or GUI listens on —
 * Seatbelt opens the provider's port to every host (it cannot name a remote host), so that port
 * would reach them from inside the sandbox. Loopback and private LAN hosts stay allowed: an
 * operator's Ollama host is one.
 */
export function providerUrlProblem(
  text: string,
  reservedPorts: readonly number[] = BAYON_DEFAULT_PORTS,
): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "must be http or https";
  if (url.hostname === "") return "names no host";
  if (url.username !== "" || url.password !== "")
    return "must not carry credentials (user:password@): providers are keyless here";
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(text))
    return "must have no query or fragment";
  if (linkLocal(url.hostname))
    return `names a link-local host (${url.hostname}), where metadata services answer`;
  const port = portOfUrl(url);
  if (reservedPorts.includes(port))
    return `uses port ${port}, which Bayon's own API or GUI listens on: the sandbox opens a provider's port to every host, so the model could reach it`;
  return null;
}

const ProviderUrl = z.string().superRefine((text, ctx) => {
  const problem = providerUrlProblem(text);
  if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
});

/** An opencode model's settings (`models.settings_json`): only these keys, never a secret. */
export const ModelSettings = z.strictObject({
  /** The provider's base URL for this model, e.g. `http://<ollama-host>:11434/v1`. */
  provider_url: ProviderUrl.optional(),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

const Providers = z
  .record(z.string().min(1), z.unknown())
  .default(() => structuredClone(DEFAULTS.providers));

const invalid = (message: string): Result<never> =>
  err(frmError("validation", message));

/** The provider blocks the runner row's defaults declare (the shipped ones when it names none). */
function providersOf(
  defaults: Readonly<Record<string, unknown>>,
): Result<Readonly<Record<string, unknown>>> {
  const parsed = Providers.safeParse(defaults["providers"]);
  return parsed.success
    ? ok(parsed.data)
    : invalid(
        `the ${RUNNER_ID} runner's providers are not an object of provider blocks`,
      );
}

/** The block a session runs `provider` with: the runner's, with the model's own URL if it has one. */
export function blockFor(
  block: ProviderBlock,
  settings: ModelSettings,
): ProviderBlock {
  return settings.provider_url === undefined
    ? block
    : {
        ...block,
        options: { ...block.options, baseURL: settings.provider_url },
      };
}

/** A models row's settings as the adapter reads them at spawn; refused like the hook refuses them. */
export function parseModelSettings(
  settings: Readonly<Record<string, unknown>> | undefined,
): Result<ModelSettings> {
  const parsed = ModelSettings.safeParse(settings ?? {});
  return parsed.success
    ? ok(parsed.data)
    : invalid(`model settings: ${z.prettifyError(parsed.error)}`);
}

/** The hook: `provider/model`, a keyless provider the runner can serve, and valid settings. */
export function validateOpencodeModel(
  row: ModelProposal,
  ctx: ModelContext,
): Result<void> {
  const model = parseModel(row.model);
  if (!model.ok) return model;
  if (row.effort !== undefined) {
    return invalid(
      `${RUNNER_ID} has no reasoning effort setting: leave effort empty`,
    );
  }
  const settings = parseModelSettings(row.settings);
  if (!settings.ok) return settings;
  const url = settings.value.provider_url;
  const problem =
    url === undefined ? null : providerUrlProblem(url, ctx.reservedPorts);
  if (problem !== null)
    return invalid(`model settings: provider_url ${problem}`);
  const providers = providersOf(ctx.defaults);
  if (!providers.ok) return providers;
  const { provider } = model.value;
  const raw = providers.value[provider];
  if (raw === undefined) {
    return invalid(
      `no provider block for ${JSON.stringify(provider)} in the ${RUNNER_ID} runner's providers (${Object.keys(providers.value).join(", ") || "none"})`,
    );
  }
  const block = ProviderBlock.safeParse(raw);
  if (!block.success) {
    return invalid(`provider ${provider}: ${z.prettifyError(block.error)}`);
  }
  return ok(undefined);
}

/**
 * What a model's settings open, in words for the operator's `--yes`: Seatbelt allows
 * outbound TCP by port only (`(remote tcp "*:<port>")`, sandbox.ts), so the provider URL's port is
 * open to every host from inside the sandbox, not only to the provider's. Null when the settings
 * open nothing.
 */
export function opencodeSettingsNote(
  settings: Readonly<Record<string, unknown>>,
): string | null {
  const parsed = ModelSettings.safeParse(settings);
  const url = parsed.success ? parsed.data.provider_url : undefined;
  if (url === undefined) return null;
  return `this opens port ${portOfUrl(new URL(url))} to any host from inside the ${RUNNER_ID} sandbox (Seatbelt can't restrict by host)`;
}
