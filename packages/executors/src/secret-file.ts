// The Linux host secret store's reader (§14): one secret per file in a
// read-only directory, bind-mounted at /run/secrets. node:fs only, so the API and the web server
// import it (`@bayon/executors/secret-file`) without the rest of this package. A value never reaches
// a message, a cause or a log: errors name the file, its mode, or the variables, nothing else.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { frmError } from "./errors.js";

/** Where a container finds its secrets (the compose-secrets convention). */
export const DEFAULT_SECRETS_DIR = "/run/secrets";

/** A secret larger than this is refused: the store holds tokens and keys, not files. */
export const MAX_SECRET_BYTES = 64 * 1024;

/** A secret's file name: letters, digits, '.', '_' and '-', never a leading dot. */
const SECRET_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Which host store a process reads: `FRM_SECRET_STORE`, unset meaning today's Keychain. */
export type SecretStoreKind = "keychain" | "file";

/** Variables that must not exist when the file store is on: a secret in env is in `docker inspect`. */
const FILE_STORE_FORBIDDEN = ["FRM_API_TOKEN", "FRM_WEB_PASSWORD_HASH"];
const FILE_STORE_FORBIDDEN_PREFIX = "FRM_SECRET_";
/** The one FRM_SECRET_* name that is a setting, not a secret: the switch itself. */
const STORE_SWITCH = "FRM_SECRET_STORE";

type Env = Readonly<Record<string, string | undefined>>;

const refuse = (message: string, cause?: unknown): Result<never> =>
  err(frmError("validation", message, cause === undefined ? {} : { cause }));

const codeOf = (e: unknown): string =>
  e instanceof Error && "code" in e && typeof e.code === "string"
    ? e.code
    : "error";

/** `FRM_SECRET_STORE`: unset or `keychain` is the Keychain (the Mac, CI, smokes); `file` the files. */
export function secretStoreKind(env: Env): Result<SecretStoreKind> {
  const value = env.FRM_SECRET_STORE;
  if (value === undefined || value === "" || value === "keychain")
    return ok("keychain");
  if (value === "file") return ok("file");
  return refuse(
    `FRM_SECRET_STORE must be "file" or "keychain", not ${JSON.stringify(value)}`,
  );
}

/**
 * With the file store on, the names of the variables that must not be set (never their values):
 * any FRM_SECRET_*, FRM_API_TOKEN and FRM_WEB_PASSWORD_HASH. A stray variable could otherwise
 * redirect a secret, and every one of them would show in `docker inspect`.
 */
export function fileStoreEnvProblem(env: Env): string | null {
  const found = Object.keys(env)
    .filter(
      (name) =>
        env[name] !== undefined &&
        name !== STORE_SWITCH &&
        (name.startsWith(FILE_STORE_FORBIDDEN_PREFIX) ||
          FILE_STORE_FORBIDDEN.includes(name)),
    )
    .sort();
  return found.length === 0
    ? null
    : `the file secret store is on (FRM_SECRET_STORE=file), so secrets never come from the environment: unset ${found.join(", ")}`;
}

/** `FRM_SECRETS_DIR`, else /run/secrets; it must be absolute. */
export function secretsDir(env: Env): Result<string> {
  const dir = env.FRM_SECRETS_DIR || DEFAULT_SECRETS_DIR;
  return isAbsolute(dir)
    ? ok(dir)
    : refuse(`FRM_SECRETS_DIR must be an absolute path, not ${dir}`);
}

/** The file that holds secret `name` in `dir`; a name that could leave `dir` is refused. */
export function secretPath(dir: string, name: string): Result<string> {
  return SECRET_NAME.test(name)
    ? ok(join(dir, name))
    : refuse(
        `secret name ${JSON.stringify(name)} is not letters, digits, '.', '_' or '-'`,
      );
}

/**
 * One secret file: a regular file (never followed through a symlink) of 1 B to 64 KiB, with no write
 * bit and nothing for others (0400 and 0440 pass), its one trailing newline stripped. A missing file
 * is `validation` with cause `{ code: "ENOENT" }`, so a store can report it as a miss.
 */
export function readSecretFile(path: string): Result<string> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = codeOf(e);
    return refuse(
      code === "ELOOP"
        ? `secret file ${path} is a symbolic link; it must be a regular file`
        : `secret file ${path} cannot be opened (${code})`,
      { code },
    );
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile())
      return refuse(`secret file ${path} is not a regular file`);
    const mode = st.mode & 0o777;
    if ((mode & 0o222) !== 0 || (mode & 0o007) !== 0) {
      return refuse(
        `secret file ${path} has mode ${mode.toString(8).padStart(4, "0")}: it must be read-only and closed to others (0400 or 0440)`,
      );
    }
    if (st.size === 0) return refuse(`secret file ${path} is empty`);
    if (st.size > MAX_SECRET_BYTES)
      return refuse(
        `secret file ${path} is larger than ${MAX_SECRET_BYTES} bytes`,
      );
    const buffer = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buffer, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    const text = buffer
      .subarray(0, read)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    return text === "" ? refuse(`secret file ${path} is empty`) : ok(text);
  } finally {
    closeSync(fd);
  }
}

/**
 * Secret `name` for a server that reads its own (the API's bearer, the web server's two): from the
 * file store, with the environment checked first. Only when `FRM_SECRET_STORE=file`.
 */
export function readNamedSecret(env: Env, name: string): Result<string> {
  const problem = fileStoreEnvProblem(env);
  if (problem !== null) return refuse(problem);
  const dir = secretsDir(env);
  if (!dir.ok) return dir;
  const path = secretPath(dir.value, name);
  return path.ok ? readSecretFile(path.value) : path;
}
