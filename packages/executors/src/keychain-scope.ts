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

/**
 * The install a process belongs to: `FRM_HOME`; else the directory of `FRM_DB` (the API runs on
 * `FRM_DB` alone, and `$FRM_HOME/foreman.db` is the one layout); else the default home.
 */
export function installHome(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const home = env.FRM_HOME;
  if (home !== undefined && home !== "") return home;
  const db = env.FRM_DB;
  if (db !== undefined && db !== "") return dirname(db);
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
  env: Readonly<Record<string, string | undefined>>,
  ownerHome: string = defaultHome(),
): KeychainScope {
  const home = real(installHome(env));
  if (home === real(ownerHome))
    return { service: OWNER_KEYCHAIN_SERVICE, owner: true };
  const hash = createHash("sha256")
    .update(home)
    .digest("hex")
    .slice(0, SERVICE_HASH_HEX);
  return { service: `${OWNER_KEYCHAIN_SERVICE}-${hash}`, owner: false };
}
