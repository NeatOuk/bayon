// The edge server's configuration: secrets from the file store only, the
// allowed origins exactly FRM_WEB_ORIGINS (no localhost defaults), the API on the internal network.
import { err, ok, type Result } from "@bayon/core";
import { readNamedSecret, secretStoreKind } from "@bayon/executors/secret-file";
import type { EdgeConfig } from "./edge.js";
import { extraOrigins } from "./origin-guard.js";
import { parsePasswordHash } from "./password.js";

export const EDGE_DEFAULTS = {
  host: "0.0.0.0",
  port: 5173,
  apiTarget: "http://api:3010",
} as const;

/** The API refuses a shorter bearer at boot; so does the edge. */
const MIN_TOKEN_LENGTH = 16;

export interface EdgeSetup {
  readonly listen: { readonly host: string; readonly port: number };
  readonly config: EdgeConfig;
}

const refuse = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** FRM_WEB_HOST, FRM_WEB_PORT, FRM_WEB_ORIGINS, FRM_API_TARGET and the two secret files. */
export function loadEdgeConfig(
  env: Readonly<Record<string, string | undefined>>,
  staticDir: string,
): Result<EdgeSetup> {
  const kind = secretStoreKind(env);
  if (!kind.ok) return kind;
  if (kind.value !== "file") {
    return refuse(
      "the edge server reads its secrets from files only: set FRM_SECRET_STORE=file (and FRM_SECRETS_DIR)",
    );
  }
  let origins: readonly string[];
  try {
    origins = extraOrigins(env.FRM_WEB_ORIGINS);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  if (origins.length === 0) {
    return refuse(
      "FRM_WEB_ORIGINS is required: the address the GUI is opened at, e.g. http://<docker-host>:5173",
    );
  }
  let apiTarget: URL;
  try {
    apiTarget = new URL(env.FRM_API_TARGET ?? EDGE_DEFAULTS.apiTarget);
  } catch {
    return refuse(`FRM_API_TARGET is not a URL: ${String(env.FRM_API_TARGET)}`);
  }
  if (apiTarget.protocol !== "http:" || apiTarget.pathname !== "/") {
    return refuse(
      "FRM_API_TARGET must be a bare http origin, e.g. http://api:3010",
    );
  }
  const port = Number(env.FRM_WEB_PORT ?? EDGE_DEFAULTS.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return refuse(`FRM_WEB_PORT is not a port: ${String(env.FRM_WEB_PORT)}`);
  }
  const token = readNamedSecret(env, "FRM_API_TOKEN");
  if (!token.ok) return token;
  if (token.value.length < MIN_TOKEN_LENGTH) {
    return refuse(
      `FRM_API_TOKEN needs at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  const hashText = readNamedSecret(env, "FRM_WEB_PASSWORD_HASH");
  if (!hashText.ok) return hashText;
  const passwordHash = parsePasswordHash(hashText.value);
  if (!passwordHash.ok) return passwordHash;
  return ok({
    listen: { host: env.FRM_WEB_HOST || EDGE_DEFAULTS.host, port },
    config: {
      origins: new Set(origins),
      apiTarget,
      token: token.value,
      passwordHash: passwordHash.value,
      staticDir,
    },
  });
}
