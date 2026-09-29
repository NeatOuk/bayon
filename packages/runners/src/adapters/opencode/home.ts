// The session's private home (§11.3) and what opencode reads from it, pure:
// the XDG layout inside spec.homeDir, the child's env, and the session config that rides in
// OPENCODE_CONFIG_CONTENT. Nothing here holds a secret: the MCP bearer and any provider key are
// `{env:NAME}` references opencode substitutes from its own env at load.
import { err, ok, type Result } from "@bayon/core";
import { SESSION_GIT_ENV } from "@bayon/executors";
import { join } from "node:path";
import { z } from "zod";
import { frmError } from "../../errors.js";
import { permissionConfig, type PermissionInput } from "./permissions.js";
import { CTX_TOKEN_ENV, MCP_TOKEN_ENV } from "./tool-names.js";

/** Directories under the session home; the host creates them, config read-only (design fact 3). */
export const HOME_DIRS = {
  home: "home",
  tmp: "tmp",
  config: "xdg/config",
  data: "xdg/data",
  cache: "xdg/cache",
  state: "xdg/state",
} as const;
/** opencode's own config dir: 0555, so no background `npm install` ever runs in it. */
export const READ_ONLY_DIR = `${HOME_DIRS.config}/opencode`;

/** An `{env:NAME}` reference: how a provider's address can come from the operator's env. */
const ENV_REF = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const EnvRef = z
  .string()
  .regex(ENV_REF, { message: "must be an {env:NAME} reference" });

/**
 * Why keyed providers are refused (the security review): opencode hands its whole env to the
 * model's shell, so a key there would be the model's to read. Until provider calls go through the
 * host the way MCP does, only providers that need no key (Ollama) run.
 */
const KEYLESS_ONLY =
  "keyed providers are not supported yet: opencode hands its whole env to the model's shell, so a key would be readable there; use a provider that needs none (Ollama)";

/** One opencode provider block, as the operator writes it into the runner row or a profile. */
export const ProviderBlock = z.looseObject({
  npm: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  options: z
    .looseObject({
      // An address is operator data: a literal URL in the row or profile, or an {env:NAME}.
      baseURL: z.union([z.url(), EnvRef]).optional(),
      apiKey: z.never({ error: KEYLESS_ONLY }).optional(),
      headers: z.never({ error: KEYLESS_ONLY }).optional(),
    })
    .optional(),
  models: z.record(z.string(), z.looseObject({})).optional(),
});
export type ProviderBlock = z.infer<typeof ProviderBlock>;

/** `provider/model`, split at the first slash (opencode's `Provider.parseModel`). */
export function parseModel(
  model: string,
): Result<{ readonly provider: string; readonly id: string }> {
  const m = /^([A-Za-z0-9_.-]+)\/(\S+)$/.exec(model);
  return m === null || m[1] === undefined || m[2] === undefined
    ? err(
        frmError(
          "validation",
          `model ${JSON.stringify(model)} is not provider/model`,
        ),
      )
    : ok({ provider: m[1], id: m[2] });
}

export interface SessionConfigInput extends PermissionInput {
  readonly model: string;
  readonly provider: string;
  readonly modelId: string;
  readonly block: ProviderBlock;
  /**
   * The session's context proxy (spec M12): the provider's base URL while compression is on, reached
   * with its bearer in a header that is an `{env:…}` reference, so the config never holds it.
   */
  readonly modelProxy?: { readonly url: string; readonly header: string };
}

/**
 * A provider block pointed at the context proxy: the adapter's own, never the operator's (whose
 * ProviderBlock still refuses headers), so it is no ProviderBlock.
 */
function proxied(
  block: ProviderBlock,
  proxy: NonNullable<SessionConfigInput["modelProxy"]>,
): Readonly<Record<string, unknown>> {
  return {
    ...block,
    options: {
      ...block.options,
      baseURL: proxy.url,
      headers: { [proxy.header]: `{env:${CTX_TOKEN_ENV}}` },
    },
  };
}

/** The session config (design §4): every key the session's safety rests on. */
export function sessionConfig(c: SessionConfigInput): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    // Invariant 7: no compaction — an overflow fails the turn, and the session hands off.
    compaction: { auto: false, prune: false },
    lsp: false,
    formatter: false,
    model: c.model,
    enabled_providers: [c.provider],
    provider: {
      [c.provider]: {
        ...(c.modelProxy === undefined
          ? c.block
          : proxied(c.block, c.modelProxy)),
        models: {
          ...c.block.models,
          [c.modelId]: {
            name: c.modelId,
            tool_call: true,
            ...c.block.models?.[c.modelId],
          },
        },
      },
    },
    // No second model call per session for a title (design fact 14).
    agent: { title: { disable: true } },
    permission: permissionConfig(c),
    // No `mcp` here: the host hands opencode the MCP server over ACP (session/new's mcpServers),
    // at its loopback proxy with a per-session proxy bearer, so neither this config (visible to
    // the model in opencode's env) nor the env holds either.
  };
}

/** The switches every session runs with (design fact 5). */
export const SWITCHES: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_PURE: "1",
};

/** Where opencode keeps what it must read outside the worktree: truncated tool output, its tmp. */
export const ownDirs = (homeDir: string): readonly string[] => [
  join(homeDir, HOME_DIRS.data, "opencode", "tool-output"),
  join(homeDir, HOME_DIRS.tmp, "opencode"),
];

/** What opencode's env may hold beyond the switches, config and git settings: nothing secret. */
const BASE_ALLOW: readonly string[] = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

/** The env names a provider block reads through `{env:…}`: addresses, never keys (refused above). */
export const envRefsOf = (block: ProviderBlock): readonly string[] => {
  const url = block.options?.baseURL;
  const m = url === undefined ? null : ENV_REF.exec(url);
  return m?.[1] === undefined ? [] : [m[1]];
};

/** The address a provider block's base URL resolves to in `env`, if it is one. */
export const baseUrlOf = (
  block: ProviderBlock,
  env: Readonly<Record<string, string>>,
): string | undefined => {
  const url = block.options?.baseURL;
  if (url === undefined) return undefined;
  const m = ENV_REF.exec(url);
  return m?.[1] === undefined ? url : env[m[1]];
};

/**
 * The turn host's env and the names it may pass on to opencode (design §4, the security review).
 * The host holds everything spec.env holds and the MCP bearer; opencode gets only `allow`, plus the
 * server password and proxy URL the host adds itself. HOME, XDG and TMPDIR are inside the session
 * home, so test 15's decoy HOME is never read.
 */
export function hostEnv(
  specEnv: Readonly<Record<string, string>>,
  homeDir: string,
  config: Record<string, unknown>,
  mcpToken: string | undefined,
  providerEnv: readonly string[],
  /** The context proxy's bearer (spec M12), for opencode's provider header. */
  proxyToken?: string,
): {
  readonly env: Record<string, string>;
  readonly allow: readonly string[];
} {
  const own: Record<string, string> = {
    HOME: join(homeDir, HOME_DIRS.home),
    TMPDIR: join(homeDir, HOME_DIRS.tmp),
    XDG_CONFIG_HOME: join(homeDir, HOME_DIRS.config),
    XDG_DATA_HOME: join(homeDir, HOME_DIRS.data),
    XDG_CACHE_HOME: join(homeDir, HOME_DIRS.cache),
    XDG_STATE_HOME: join(homeDir, HOME_DIRS.state),
    ...SWITCHES,
    // The model's own git (the security review, now every runner's): no system or global
    // config, hook, fsmonitor, credential helper or askpass, whatever a repository's config says.
    ...SESSION_GIT_ENV,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
  return {
    env: {
      ...specEnv,
      ...own,
      ...(mcpToken === undefined ? {} : { [MCP_TOKEN_ENV]: mcpToken }),
      ...(proxyToken === undefined ? {} : { [CTX_TOKEN_ENV]: proxyToken }),
    },
    allow: [
      ...new Set([
        ...BASE_ALLOW,
        ...Object.keys(own),
        ...providerEnv.filter((n) => n !== MCP_TOKEN_ENV),
        // opencode reads it for its provider header; the model's shell, which inherits opencode's
        // env, can read it too (the spike's residual: it reaches only this session's proxy).
        ...(proxyToken === undefined ? [] : [CTX_TOKEN_ENV]),
      ]),
    ],
  };
}
