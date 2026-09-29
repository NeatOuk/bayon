// A session's config (§11.3), compiled from its profile and runner rows. config_hash (§8.1) hashes
// `input`: content only (no id, name, version or created_at), secret names never values.
import {
  COMMAND_POLICY_FLAG,
  defaultCommandPolicy,
  err,
  ok,
  readsGrantedLogin,
  type JsonValue,
  type Result,
} from "@bayon/core";
import type { ProfileRow, RunnerRow } from "@bayon/db";
import { SESSION_GIT_ENV } from "@bayon/executors";
import { z } from "zod";
import { frmError } from "./errors.js";

const JsonObject = z.record(z.string(), z.json());
/** An environment variable name (§11.3). Exported: resolveSpawn holds a spawn's own env to it too. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EnvName = z.string().regex(ENV_NAME, "not an environment variable name");
const Columns = z.object({
  defaults: JsonObject,
  permission: JsonObject,
  sandbox: JsonObject,
  env: z.record(EnvName, z.string()),
  secret_refs: z.array(EnvName),
  mcp: JsonObject,
  hooks: JsonObject,
  skills_refs: z.array(z.json()),
  tool_allowlist: z.array(z.json()),
});
const Defaults = z.looseObject({
  secretEnv: z.array(EnvName).optional(),
  /** One-of: the first alternative whose names are all in the store is injected, alone. */
  secretEnvAnyOf: z.array(z.array(EnvName).min(1)).optional(),
  hashInputs: z.array(z.string().min(1)).optional(),
  /**
   * The smallest context a session with the runner's own tools needs before it reads a file
   *. Admission's context_baseline refuses a run class whose cap is below it.
   */
  sessionBaselineTokens: z.int().nonnegative().optional(),
});

/** The supervisor sets these last; a profile may not (§11.3). */
export const RESERVED_ENV: ReadonlySet<string> = new Set([
  "HOME",
  "TMPDIR",
  "PATH",
  "FRM_SESSION_ID",
  // The orphan scan's second tag: a profile can neither set nor forge it.
  "FRM_HOME_TAG",
  "FRM_MCP_TOKEN",
  // The session's git floor: refused by name, never silently overwritten.
  ...Object.keys(SESSION_GIT_ENV),
]);

export interface SessionConfig {
  /** What config_hash hashes. */
  readonly input: JsonValue;
  /** `SpawnSpec.flags`: runner defaults ⊕ permission ⊕ sandbox, the profile winning. */
  readonly flags: Readonly<Record<string, JsonValue>>;
  /** Non-secret env from the profile. */
  readonly env: Readonly<Record<string, string>>;
  /** Resolved from the secret store at spawn: the runner's secretEnv ∪ the profile's refs. */
  readonly secretNames: readonly string[];
  /** The runner's secretEnvAnyOf, in declared order: the first present alternative is injected. */
  readonly secretAnyOf: readonly (readonly string[])[];
  /**
   * The runner row declares that it reads a login granted in place (core READS_GRANTED_LOGIN,
   *); absent is false. resolveCredentials refuses a grant to a runner without it.
   */
  readonly readsGrantedLogin?: boolean;
  /** Doctrine files the runner loads, hashed with the repo's (§8.1). */
  readonly hashInputs: readonly string[];
  /**
   * The runner's sessionBaselineTokens, from its row alone (a profile cannot lower it); 0 when it
   * declares none. Admission's context_baseline reads it.
   */
  readonly baselineTokens: number;
  /** The profile's MCP tool allowlist as stored; toolsetFor validates it. */
  readonly toolAllowlist: readonly unknown[];
}

function parseColumns(
  columns: Readonly<Record<string, string>>,
): Result<Record<string, unknown>> {
  const parsed: [string, unknown][] = [];
  for (const [name, text] of Object.entries(columns)) {
    try {
      parsed.push([name, JSON.parse(text) as unknown]);
    } catch {
      return err(frmError("validation", `${name} is not JSON`));
    }
  }
  return ok(Object.fromEntries(parsed));
}

const invalid = (what: string, e: z.ZodError): Result<never> =>
  err(frmError("validation", `${what}: ${z.prettifyError(e)}`));

/** `role` is the session's: a profile with no permission_json gets that role's command policy. */
export function parseConfig(
  profile: ProfileRow,
  runner: RunnerRow,
  role: string,
): Result<SessionConfig> {
  const json = parseColumns({
    defaults: runner.defaults_json,
    permission: profile.permission_json,
    sandbox: profile.sandbox_json,
    env: profile.env_json,
    secret_refs: profile.secret_refs_json,
    mcp: profile.mcp_json,
    hooks: profile.hooks_json,
    skills_refs: profile.skills_refs_json,
    tool_allowlist: profile.tool_allowlist_json,
  });
  if (!json.ok) return json;
  const c = Columns.safeParse(json.value);
  if (!c.success) return invalid(`profile ${profile.id}`, c.error);
  const d = Defaults.safeParse(c.data.defaults);
  if (!d.success) return invalid(`runner ${runner.id} defaults`, d.error);
  const secretNames = [
    ...new Set([...(d.data.secretEnv ?? []), ...c.data.secret_refs]),
  ].toSorted();
  const secretAnyOf = d.data.secretEnvAnyOf ?? [];
  const reserved = [
    ...Object.keys(c.data.env),
    ...secretNames,
    ...secretAnyOf.flat(),
  ].filter((name) => RESERVED_ENV.has(name));
  if (reserved.length > 0) {
    return err(
      frmError(
        "validation",
        `profile ${profile.id} sets ${reserved.join(", ")}, which the supervisor owns`,
      ),
    );
  }
  const { defaults, ...rest } = c.data;
  // A profile that states no permissions gets its role's default command policy, runner-neutral,
  // for its adapter to map; one that states its own keeps them whole. The policy is
  // hashed with the rest (§8.1), so an adopt resumes with the flags its spawn had.
  const policy =
    Object.keys(c.data.permission).length === 0
      ? defaultCommandPolicy(role)
      : undefined;
  const withPolicy = policy === undefined ? {} : { command_policy: policy };
  return ok({
    input: {
      v: 1,
      runner: { id: runner.id, defaults },
      profile: { model_tier: profile.model_tier, ...rest },
      ...withPolicy,
    },
    flags: {
      ...defaults,
      ...(policy === undefined ? {} : { [COMMAND_POLICY_FLAG]: policy }),
      ...c.data.permission,
      ...c.data.sandbox,
    },
    env: c.data.env,
    secretNames,
    secretAnyOf,
    readsGrantedLogin: readsGrantedLogin(d.data),
    hashInputs: d.data.hashInputs ?? [],
    baselineTokens: d.data.sessionBaselineTokens ?? 0,
    toolAllowlist: c.data.tool_allowlist,
  });
}

/** What config_hash hashes, for a profile, its runner and the session's role. Pure. */
export function configInput(
  profile: ProfileRow,
  runner: RunnerRow,
  role: string,
): Result<JsonValue> {
  const config = parseConfig(profile, runner, role);
  return config.ok ? ok(config.value.input) : config;
}
