// The API's bearer, read the same way by the API, the GUI's dev server and frm:
// FRM_API_TOKEN in the environment; else this install's own store — the file FRM_API_TOKEN with
// FRM_SECRET_STORE=file, or the
// Keychain under this home's service, which `frm init` fills. A value never reaches a
// message: a miss is `undefined`, for the caller to explain.
import { ok, type Result } from "@bayon/core";
import { readNamedSecret, secretStoreKind } from "./secret-file.js";
import { HOME_TAG_ENV, SESSION_ID_ENV } from "./local/proc-scan.js";
import { hostSecrets, type KeychainOptions } from "./secrets.js";

type Env = Readonly<Record<string, string | undefined>>;

export const API_TOKEN_NAME = "FRM_API_TOKEN";

export interface ApiTokenOptions {
  /** The `security` binary; tests point it at a stand-in. */
  readonly keychain?: KeychainOptions;
}

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== "";

/**
 * Whether the Keychain may be asked for the bearer. Not inside an agent session (its env carries
 * the session id or the home tag): an agent's `pnpm --filter @bayon/web dev` or `frm` must never
 * pick up its supervisor's bearer. And not when the env names no home (neither FRM_HOME nor
 * FRM_DB): a bare run in some worktree would otherwise fall back to the default home's, the live
 * install's. frm's own default home is named explicitly (homeEnvOf sets FRM_HOME) before it reads.
 */
export function mayReadStoredToken(env: Env): boolean {
  if (isSet(env[SESSION_ID_ENV]) || isSet(env[HOME_TAG_ENV])) return false;
  return isSet(env.FRM_HOME) || isSet(env.FRM_DB);
}

export async function readApiToken(
  env: Env,
  o: ApiTokenOptions = {},
): Promise<Result<string | undefined>> {
  const kind = secretStoreKind(env);
  if (!kind.ok) return kind;
  if (kind.value === "file") return readNamedSecret(env, API_TOKEN_NAME);
  const fromEnv = env[API_TOKEN_NAME];
  if (fromEnv !== undefined && fromEnv !== "") return ok(fromEnv);
  if (!mayReadStoredToken(env)) return ok(undefined);
  const host = hostSecrets(
    env,
    o.keychain === undefined ? {} : { keychain: o.keychain },
  );
  if (!host.ok) return host;
  const stored = await host.value.stores.host.get(API_TOKEN_NAME);
  return ok(stored.ok ? stored.value : undefined);
}
