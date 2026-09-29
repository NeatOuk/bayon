// How frm reaches this home's API: the URL from FRM_API_URL, else the home's
// own host and port (install.json, FRM_API_PORT), never the default install's by accident; the
// bearer from FRM_API_TOKEN, else this home's own store (`frm init` put it there). Never printed.
import type { Result } from "@bayon/core";
import type { HomeEnv } from "./home.js";
import { apiUrl, readApiToken, type KeychainOptions } from "@bayon/executors";

type Env = Readonly<Record<string, string | undefined>>;

/** This home's API origin, without a trailing slash. */
export const apiBaseOf = (env: Env): Result<string> => apiUrl(env);

/** This home's bearer; `undefined` when neither the env nor the store has one. */
export const apiTokenOf = (
  env: Env,
  keychain?: KeychainOptions,
): Promise<Result<string | undefined>> =>
  readApiToken(env, keychain === undefined ? {} : { keychain });

/** What frm says when there is no bearer: the one command that makes one. */
export const NO_API_TOKEN =
  "no API token: FRM_API_TOKEN is not set and this home's store has none (run pnpm frm init)";

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== "";

/**
 * The env an API call reads its URL and bearer with: the env's own when it names a token, a home or
 * an API; else, and only then, the default home `home` resolves (homeEnvOf), which sets FRM_HOME
 * explicitly, so that home's stored bearer may be read (a bare env never reads one). With a home
 * that is refused (FRM_NO_DEFAULT_HOME), the env as it is: no bearer, and the caller says so.
 */
export function apiEnvOf(
  env: Env,
  home: (() => Result<HomeEnv>) | undefined,
): Env {
  const named = ["FRM_API_TOKEN", "FRM_HOME", "FRM_DB", "FRM_API_URL"].some(
    (name) => isSet(env[name]),
  );
  if (named || home === undefined) return env;
  const resolved = home();
  return resolved.ok ? resolved.value.env : env;
}
