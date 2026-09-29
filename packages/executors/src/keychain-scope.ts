// Which Keychain service a process reads (§14): the Keychain store belongs to one
// install. The operator's default home (`~/.foreman`) reads service `foreman`, as it always has;
// any other home — a scratch API, a test rig, a smoke, a second install — reads a service derived
// from its own real path, so it can never see the live install's secrets by falling back to them.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The live install's service: what every `security … -s foreman` in the docs names. */
export const OWNER_KEYCHAIN_SERVICE = "foreman";

/** The default install's directory under the account's home. */
const DEFAULT_HOME_DIR = ".foreman";

/** How many hex digits of the home's hash name a non-default install's service. */
const SERVICE_HASH_HEX = 12;

/**
 * The account's default home: `<login home>/.foreman`, the login home taken from the password
 * database, not `$HOME` — a rig that points `HOME` at a temp dir cannot pass its own `.foreman` off
 * as the operator's.
 */
export const defaultHome = (): string =>
  join(userInfo().homedir, DEFAULT_HOME_DIR);

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Set, the default home is never used (vitest.setup.ts sets it for every test worker and every
 * child a test spawns; `frm smoke` for its children): a process that names no home resolves to
 * GUARDED_HOME instead, so no test reads ~/.foreman's install file or its Keychain service.
 */
export const NO_DEFAULT_HOME_ENV = "FRM_NO_DEFAULT_HOME";

/** Where a guarded process with no home resolves: a path that cannot exist, so nothing is read. */
export const GUARDED_HOME = "/nonexistent/frm-no-default-home";

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== "";

/**
 * The install a process belongs to: `FRM_HOME`; else the directory of `FRM_DB` (the API runs on
 * `FRM_DB` alone, and `$FRM_HOME/foreman.db` is the one layout); else the default home — or, under
 * FRM_NO_DEFAULT_HOME (in `env` or `guard`, the process's own env by default), GUARDED_HOME.
 */
export function installHome(env: Env, guard: Env = process.env): string {
  const home = env.FRM_HOME;
  if (home !== undefined && home !== "") return home;
  const db = env.FRM_DB;
  if (db !== undefined && db !== "") return dirname(db);
  if (isSet(env[NO_DEFAULT_HOME_ENV]) || isSet(guard[NO_DEFAULT_HOME_ENV]))
    return GUARDED_HOME;
  return defaultHome();
}

/** A path's realpath; one that does not exist yet compares by its resolved form. */
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export interface KeychainScope {
  /** The Keychain service this install's secrets are generic passwords of. */
  readonly service: string;
  /** True only for the account's default home: the live install. */
  readonly owner: boolean;
}

/**
 * The install's Keychain scope. `ownerHome` is for tests of this function only: production callers
 * go through `hostSecrets`, which never passes it.
 */
export function keychainScope(
  env: Env,
  ownerHome: string = defaultHome(),
  guard: Env = process.env,
): KeychainScope {
  const home = real(installHome(env, guard));
  if (home === real(ownerHome))
    return { service: OWNER_KEYCHAIN_SERVICE, owner: true };
  const hash = createHash("sha256")
    .update(home)
    .digest("hex")
    .slice(0, SERVICE_HASH_HEX);
  return { service: `${OWNER_KEYCHAIN_SERVICE}-${hash}`, owner: false };
}
