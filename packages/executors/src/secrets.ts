// The host secret store (§14): values go into a child's env at spawn, or to the one job that needs
// them, and nowhere else. Shared by the supervisor (spawn secrets, the backup key) and tools/frm
// (the backup key), so both read a secret the same way: FRM_SECRET_<NAME> in the process's own
// environment first (CI, tests, smokes), then the macOS Keychain; or, with FRM_SECRET_STORE=file on
// a Linux host, the read-only files under FRM_SECRETS_DIR and nothing else.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { err, ok, type Result } from "@bayon/core";
import { frmError } from "./errors.js";
import { decodeKeychainValue } from "./keychain-hex.js";
import { keychainScope, type KeychainScope } from "./keychain-scope.js";
import {
  fileStoreEnvProblem,
  readSecretFile,
  secretPath,
  secretStoreKind,
  secretsDir,
  type SecretStoreKind,
} from "./secret-file.js";

export interface SecretStore {
  get(name: string): Promise<Result<string>>;
}

/** The cause a miss carries: the store answered, and it has no such secret. */
const NOT_FOUND = { notFound: true } as const;

// Names only: a value never reaches a message, a cause or a log.
const missing = (name: string): Result<never> =>
  err(
    frmError("validation", `secret ${name} is not in the secret store`, {
      cause: NOT_FOUND,
    }),
  );

/**
 * Whether an error is a plain miss (the store answered: no such secret), not a store that could
 * not be read (a locked or timed-out Keychain, a broken file). Only a miss may read as "not set up".
 */
export function isSecretMissing(error: { readonly cause?: unknown }): boolean {
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "notFound" in cause &&
    cause.notFound === true
  );
}

/** What `security find-generic-password` exits with when the item does not exist. */
const KEYCHAIN_NOT_FOUND = 44;

/** `FRM_SECRET_<NAME>` in the process's own environment: CI and tests. */
export const envSecrets = (
  env: Readonly<Record<string, string | undefined>>,
): SecretStore => ({
  get: async (name) => {
    const value = env[`FRM_SECRET_${name}`];
    return value === undefined ? missing(name) : ok(value);
  },
});

const execFileAsync = promisify(execFile);
/** A `security` that does not answer in this long (a locked Keychain's prompt) is a miss. */
const KEYCHAIN_TIMEOUT_MS = 10_000;

export interface KeychainOptions {
  /** The `security` binary; tests point it at a shim. */
  readonly bin?: string;
  /** How long a read may wait (default 10 s); an emergency caller such as `frm pause` waits less. */
  readonly timeoutMs?: number;
}

/**
 * The macOS Keychain: a generic password with service `service` and account `<NAME>`. Only the
 * names go into argv; the value comes back on stdout — in `security`'s hex form when it holds a
 * newline or any other byte `security` cannot print, which `decodeKeychainValue` undoes.
 */
export const keychainSecrets = (
  service: string,
  o: KeychainOptions = {},
): SecretStore => ({
  get: async (name) => {
    try {
      const { stdout } = await execFileAsync(
        o.bin ?? "security",
        ["find-generic-password", "-s", service, "-a", name, "-w"],
        { timeout: o.timeoutMs ?? KEYCHAIN_TIMEOUT_MS },
      );
      return decodeKeychainValue(name, stdout.replace(/\n$/, ""));
    } catch (e) {
      // 44: the Keychain answered, no such item. Anything else (a locked Keychain's prompt timing
      // out, a missing binary, a signal) is a store that could not be read, and says so.
      const code =
        typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
      if (code === KEYCHAIN_NOT_FOUND) return missing(name);
      const killed =
        typeof e === "object" &&
        e !== null &&
        "killed" in e &&
        e.killed === true;
      return err(
        frmError(
          "internal",
          killed
            ? `the Keychain did not answer for ${name} (a locked Keychain waits for a password)`
            : `the Keychain could not be read for ${name} (security exited ${String(code)})`,
          { retryable: true },
        ),
      );
    }
  },
});

/** The first store that has the secret. */
export const firstOf = (...stores: readonly SecretStore[]): SecretStore => ({
  get: async (name) => {
    for (const store of stores) {
      const found = await store.get(name);
      if (found.ok) return found;
    }
    return missing(name);
  },
});

/**
 * The Linux host store: `<dir>/<NAME>`, one read-only file per secret, read on
 * every get (no cache), so a rotated file is used from the next spawn. A missing file is a miss; a
 * file with a bad mode, a symlink or an oversized one is its own error, naming the file, not a value.
 */
export const fileSecrets = (dir: string): SecretStore => ({
  get: async (name) => {
    const path = secretPath(dir, name);
    if (!path.ok) return path;
    const read = readSecretFile(path.value);
    if (read.ok) return read;
    const cause = read.error.cause;
    const absent =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT";
    return absent ? missing(name) : read;
  },
});

/** Which host store answered a sourced read. */
export type SecretSource = "env" | "keychain" | "file";

/** The host's two stores, kept apart so a caller can tell which one answered. */
export interface HostSecretStores {
  /** `envSecrets(process.env)`: FRM_SECRET_<NAME>; never answers when the file store is on. */
  readonly env: SecretStore;
  /** The Keychain on the Mac, the files on a Linux host. */
  readonly host: SecretStore;
  readonly hostSource: Exclude<SecretSource, "env">;
}

export interface SourcedSecret {
  readonly value: string;
  readonly source: SecretSource;
}

/**
 * firstOf(env, host)'s order, saying which store answered: a caller that must not be silently
 * redirected (the backup key) warns when the environment wins. Spawn secrets keep using firstOf.
 */
export async function getSourced(
  stores: HostSecretStores,
  name: string,
): Promise<Result<SourcedSecret>> {
  const fromEnv = await stores.env.get(name);
  if (fromEnv.ok) return ok({ value: fromEnv.value, source: "env" });
  const fromHost = await stores.host.get(name);
  // The host store's own error: a miss stays a miss, a store that could not be read says so.
  return fromHost.ok
    ? ok({ value: fromHost.value, source: stores.hostSource })
    : fromHost;
}

export interface HostSecrets {
  readonly kind: SecretStoreKind;
  /** The sourced pair: the backup key's reader says which one answered. */
  readonly stores: HostSecretStores;
  /** firstOf(env, host): what a spawn resolves its secrets from. */
  readonly spawn: SecretStore;
  /** The Keychain service this install reads; null on the file store. */
  readonly keychain: KeychainScope | null;
}

/**
 * The one selector of the host store. `FRM_SECRET_STORE` unset:
 * FRM_SECRET_<NAME>, then the Keychain under **this install's** service (`foreman` for
 * the default home only, `foreman-<hash>` for any other, derived from `env` here so no caller can
 * name another install's service). `file`: the files under `FRM_SECRETS_DIR` (default /run/secrets)
 * only, and any secret in the environment is refused.
 */
export function hostSecrets(
  env: Readonly<Record<string, string | undefined>>,
  o: {
    readonly keychain?: KeychainOptions;
    /** Tests only: the account's default home, so a temp home can stand in for it. */
    readonly ownerHome?: string;
  } = {},
): Result<HostSecrets> {
  const kind = secretStoreKind(env);
  if (!kind.ok) return kind;
  let stores: HostSecretStores;
  let keychain: KeychainScope | null = null;
  if (kind.value === "file") {
    const problem = fileStoreEnvProblem(env);
    if (problem !== null) return err(frmError("validation", problem));
    const dir = secretsDir(env);
    if (!dir.ok) return dir;
    stores = {
      env: envSecrets({}),
      host: fileSecrets(dir.value),
      hostSource: "file",
    };
  } else {
    keychain =
      o.ownerHome === undefined
        ? keychainScope(env)
        : keychainScope(env, o.ownerHome);
    stores = {
      env: envSecrets(env),
      host: keychainSecrets(keychain.service, o.keychain),
      hostSource: "keychain",
    };
  }
  return ok({
    kind: kind.value,
    stores,
    spawn: firstOf(stores.env, stores.host),
    keychain,
  });
}

/** Keychain service and account names: what `security -i` reads as one word each. */
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
/** A value `security -i` reads as one word: never quoted, so never mis-split. */
const VALUE = /^[A-Za-z0-9]{1,1024}$/;

export interface KeychainPut extends KeychainOptions {
  readonly service: string;
  readonly account: string;
  readonly value: string;
  /** Replace an existing item (`-U`); without it an existing item is a failure. */
  readonly replace: boolean;
}

/**
 * Stores a generic password. The value never enters argv (where `ps` shows it): `security -i` reads
 * the command from stdin. Its output is dropped; a failure reports the exit status and stderr with
 * every occurrence of the value redacted.
 */
export function putKeychainSecret(o: KeychainPut): Promise<Result<void>> {
  if (!NAME.test(o.service) || !NAME.test(o.account)) {
    return Promise.resolve(
      err(
        frmError(
          "validation",
          `keychain service and account are letters, digits, '.', '_' or '-': ${o.service}/${o.account}`,
        ),
      ),
    );
  }
  if (!VALUE.test(o.value)) {
    return Promise.resolve(
      err(
        frmError(
          "validation",
          "a keychain value written through security -i must be letters and digits only",
        ),
      ),
    );
  }
  const command = [
    "add-generic-password",
    ...(o.replace ? ["-U"] : []),
    "-s",
    o.service,
    "-a",
    o.account,
    "-w",
    o.value,
  ].join(" ");
  const what = `security add-generic-password for ${o.service}/${o.account}`;
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(o.bin ?? "security", ["-i"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (e) =>
      resolve(err(frmError("internal", `${what}: ${e.message}`))),
    );
    child.on("close", (code) => {
      if (code === 0) return resolve(ok(undefined));
      const said = stderr.replaceAll(o.value, "<redacted>").trim();
      resolve(
        err(
          frmError(
            "internal",
            `${what} failed (exit ${String(code)})${said === "" ? "" : `: ${said}`}`,
          ),
        ),
      );
    });
    child.stdin.on("error", () => undefined); // a child that died early: close reports it
    child.stdin.end(`${command}\n`);
  });
}
