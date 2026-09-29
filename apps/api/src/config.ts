import { err, ok, type Result } from "@bayon/core";
import {
  installPorts,
  readApiToken,
  type ApiTokenOptions,
} from "@bayon/executors/install";
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
        message:
          "No database to open: set FRM_HOME (or FRM_DB) and start the API again.",
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

/** What a missing token tells the operator: the one command that makes one for this home. */
export const NO_TOKEN_MESSAGE =
  "FRM_API_TOKEN is required: run `pnpm frm init` to store one for this home, or set it";

const ApiConfig = z.object({
  token: z
    .string(NO_TOKEN_MESSAGE)
    .min(
      MIN_TOKEN_LENGTH,
      `FRM_API_TOKEN needs at least ${MIN_TOKEN_LENGTH} characters`,
    ),
  host: z.string().min(1),
  port: z.int().min(0).max(65_535),
});
export type ApiConfig = z.infer<typeof ApiConfig>;

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** Each schema complaint on its own, without zod's bullet: they are written for the operator. */
const issues = (error: z.ZodError): string =>
  error.issues.map((issue) => issue.message).join("; ");

/**
 * The bearer, host and port. The bearer: FRM_API_TOKEN from the environment; else this home's own
 * store — the Keychain under this home's service, which `frm init` fills, or with the
 * file store on (FRM_SECRET_STORE=file) the file FRM_API_TOKEN under
 * FRM_SECRETS_DIR, where a token (or any other secret) in the environment is refused. Host and
 * port: FRM_API_HOST / FRM_API_PORT, else the home's install.json, else 127.0.0.1:3010.
 * Error messages never contain the token.
 */
export async function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  o: ApiTokenOptions = {},
): Promise<Result<ApiConfig>> {
  const token = await readApiToken(env, o);
  if (!token.ok) return invalid(token.error.message);
  const ports = installPorts(env);
  if (!ports.ok) return invalid(ports.error.message);
  const parsed = ApiConfig.safeParse({
    token: token.value,
    host: ports.value.apiHost,
    port: ports.value.apiPort,
  });
  return parsed.success ? ok(parsed.data) : invalid(issues(parsed.error));
}
