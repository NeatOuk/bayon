// The files the session's private home holds (§11.3, as data: the turn host is
// their only writer, through its `files` op, so the adapter never touches the executor's disk and
// the same code serves local and container executors. Pure.
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import { frmError } from "../../errors.js";

/** CODEX_HOME inside the session home. */
export const CODEX_DIR = "codex";
export const CONFIG_FILE = `${CODEX_DIR}/config.toml`;
export const AUTH_FILE = `${CODEX_DIR}/auth.json`;
/** The host's own record of the thread, for adopt and billing (never written through `files`). */
export const THREAD_FILE = "thread.json";
export const OUT_DIR = "out";

/** The secret env vars of `secretEnvAnyOf`. */
export const API_KEY_ENV = "CODEX_API_KEY";
export const AUTH_JSON_ENV = "CODEX_AUTH_JSON";

export type HomeFile = {
  /** Relative to the session home. */
  readonly path: string;
  readonly mode: number;
  readonly content: string;
};

const PRIVATE = 0o600;

/**
 * Housekeeping only: every security key rides `-c` on argv (argv.ts). Each key is in 0.154.0's
 * config schema, and `--strict-config` fails the turn loudly if a version drops one.
 */
export const CONFIG_TOML = `# Rendered by foreman for this session and replaced at every start. Security keys ride -c.
check_for_update_on_startup = false

[history]
persistence = "none"

[analytics]
enabled = false

[feedback]
enabled = false

[memories]
generate_memories = false
use_memories = false

[features]
multi_agent = false
`;

export const configFile = (): HomeFile => ({
  path: CONFIG_FILE,
  mode: PRIVATE,
  content: CONFIG_TOML,
});

const AuthJson = z.record(z.string(), z.unknown());

/** auth.json's fields, in the order the file held them. `undefined` when it is not one. */
export function authKeys(content: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const object = AuthJson.safeParse(parsed);
  return object.success ? Object.keys(object.data) : undefined;
}

/**
 * `content` as the session home's auth.json, 0600. `what` names the source in a refusal — the env
 * var, or the granted path — so a bad credential says where it came from. Its content never
 * appears in an error message.
 */
export function authFileOf(content: string, what: string): Result<HomeFile> {
  return authKeys(content) === undefined
    ? err(frmError("validation", `${what} is not a JSON object`))
    : ok({ path: AUTH_FILE, mode: PRIVATE, content });
}

/**
 * The auth.json fallback (amendment g), from the env var the supervisor resolved; `undefined`
 * when the API key is in use, or when the operator granted a login in place instead (§14).
 */
export function authFile(
  env: Readonly<Record<string, string>>,
): Result<HomeFile | undefined> {
  const value = env[AUTH_JSON_ENV];
  return value === undefined ? ok(undefined) : authFileOf(value, AUTH_JSON_ENV);
}

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A run's output schema (SendSpec.output), for --output-schema. */
export function schemaFile(
  runId: string,
  schema: Readonly<Record<string, unknown>>,
): Result<HomeFile> {
  return RUN_ID.test(runId)
    ? ok({
        path: `${OUT_DIR}/${runId}.schema.json`,
        mode: PRIVATE,
        content: JSON.stringify(schema),
      })
    : err(frmError("validation", `run id ${JSON.stringify(runId)}`));
}
