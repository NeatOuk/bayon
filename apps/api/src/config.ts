import { err, ok, type Result } from "@bayon/core";
import { readNamedSecret, secretStoreKind } from "@bayon/executors/secret-file";
import { join, resolve } from "node:path";
import { z } from "zod";

/** The database file: FRM_DB, else $FRM_HOME/foreman.db (the db CLI's rule). */
export function loadDbPath(
  env: Readonly<Record<string, string | undefined>>,
): Result<string> {
  const home = env.FRM_HOME;
  const path =
    env.FRM_DB ?? (home === undefined ? undefined : join(home, "foreman.db"));
  return path
    ? ok(path)
    : err({
        class: "validation",
        message: "no database: set FRM_DB or FRM_HOME",
        retryable: false,
      });
}

/** Session files (§11.3): FRM_RUNTIME_DIR, else $FRM_HOME/runtime; null when neither is set. */
export function loadRuntimeDir(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const home = env.FRM_HOME;
  const dir = env.FRM_RUNTIME_DIR || (home ? join(home, "runtime") : undefined);
  return dir ? resolve(dir) : null;
}

/**
 * Where the supervisor roots each session's worktrees: $FRM_HOME/work (its lifecycle's
 * sessionPaths), where the no_source_changes and plan checks look; null without FRM_HOME.
 */
export function loadWorkRoot(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const home = env.FRM_HOME;
  return home ? resolve(join(home, "work")) : null;
}

/**
 * Gates' evidence files: `$FRM_HOME/artifacts`, where the supervisor writes
 * each gate's diff.patch under `gates/<id>/`; null without FRM_HOME.
 */
export function loadArtifactsDir(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const home = env.FRM_HOME;
  return home ? resolve(join(home, "artifacts")) : null;
}

/**
 * Where a new project's repo mirror lives: `$FRM_HOME/mirrors` (`frm project add`'s own rule);
 * null without FRM_HOME, which `ProjectsService` refuses as a host-misconfiguration `validation`.
 */
export function loadMirrorsRoot(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const home = env.FRM_HOME;
  return home ? resolve(join(home, "mirrors")) : null;
}

/**
 * `$FRM_HOME` itself: where a new container executor's pinned host key is written, under
 * `executors/<id>/known_hosts` (`frm executor add`'s own rule); null without FRM_HOME, which
 * `ExecutorsCreateService` refuses as a host-misconfiguration `validation`, matching
 * `ProjectsService`'s `mirrorsRoot`.
 */
export function loadFrmHome(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const home = env.FRM_HOME;
  return home ? resolve(home) : null;
}

export const API_DEFAULTS = { host: "127.0.0.1", port: 3010 } as const;

/** A bearer shorter than this is refused at boot. */
export const MIN_TOKEN_LENGTH = 16;

const ApiConfig = z.object({
  token: z
    .string("FRM_API_TOKEN is required")
    .min(
      MIN_TOKEN_LENGTH,
      `FRM_API_TOKEN needs at least ${MIN_TOKEN_LENGTH} characters`,
    ),
  host: z.string().min(1).default(API_DEFAULTS.host),
  port: z.coerce
    .number()
    .pipe(z.int().min(0).max(65_535))
    .default(API_DEFAULTS.port),
});
export type ApiConfig = z.infer<typeof ApiConfig>;

/**
 * The bearer: FRM_API_TOKEN from the environment, as on the Mac; with the file store on
 * (FRM_SECRET_STORE=file, the file FRM_API_TOKEN under FRM_SECRETS_DIR, and
 * a token (or any other secret) in the environment is refused.
 */
function tokenFrom(
  env: Readonly<Record<string, string | undefined>>,
): Result<string | undefined> {
  const kind = secretStoreKind(env);
  if (!kind.ok) return kind;
  return kind.value === "file"
    ? readNamedSecret(env, "FRM_API_TOKEN")
    : ok(env.FRM_API_TOKEN);
}

/** Reads the token, FRM_API_HOST and FRM_API_PORT. Error messages never contain the token. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<ApiConfig> {
  const token = tokenFrom(env);
  if (!token.ok)
    return err({
      ...token.error,
      message: `invalid API config: ${token.error.message}`,
    });
  const parsed = ApiConfig.safeParse({
    token: token.value,
    host: env.FRM_API_HOST,
    port: env.FRM_API_PORT,
  });
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `invalid API config: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}
