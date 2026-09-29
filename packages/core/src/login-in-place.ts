// The operator's consent to use a login they already hold on this host, in place, instead of a copy
// in the secret store (§14). Some logins are not static secrets: the CLI mints access
// tokens from a refresh token, rotates it, and rewrites its own file, so a copy goes stale and every
// session started from it fails on a dead token.
//
// Consent is this `settings` row, default off (no row, no grant). It is shell-only, like every other
// security control: core's SHELL_ONLY_SETTINGS keeps it out of the GUI's whitelist, so it changes
// only through the operator door (§9.5) and every change is audited. Finding a login file is not
// consent — the row names the runner and the path, one entry per runner, and clearing it revokes.
//
// The value is a path, never a credential: nothing here reads the file. The runner is an id, so no
// runner is named in this schema (Invariant 1).
import { z } from "zod";

export const LOGIN_IN_PLACE_KEY = "runners.login_in_place";

/** A runner id, as `runners.id` holds it: letters, digits, '-', '_' and '.'. */
const RUNNER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** An absolute POSIX path with no `.` or `..` segment and no trailing slash. */
export const GRANTED_PATH = /^(?:\/(?!\.{1,2}(?:\/|$))[^/\0]+)+$/;

/**
 * `runners.login_in_place`: runner id → the absolute path of the login file that runner may read
 * and write in place. `{}` (or no row) is off.
 */
export const LoginInPlace = z.record(
  z.string().regex(RUNNER_ID, "not a runner id"),
  z
    .string()
    .regex(GRANTED_PATH, "not an absolute path without . or .. segments"),
);
export type LoginInPlace = z.infer<typeof LoginInPlace>;

export const NO_LOGINS_IN_PLACE: LoginInPlace = {};

/** The path granted to `runnerId`, or `undefined` when the operator granted it none. */
export function loginPathFor(
  grants: LoginInPlace,
  runnerId: string,
): string | undefined {
  return Object.hasOwn(grants, runnerId) ? grants[runnerId] : undefined;
}

/**
 * The runner-row defaults key by which an adapter declares that it can read a login granted in
 * place: a registration fact, beside `secretEnvAnyOf`. Only an adapter that places the
 * file and writes the rotated value back declares it; a grant to any other runner is refused.
 */
export const READS_GRANTED_LOGIN = "readsGrantedLogin";

/**
 * Whether a runner whose row holds `defaults` can read a login granted in place. Only an explicit
 * `true` counts: absent, malformed or anything else is "cannot", so a grant it cannot use is
 * refused rather than leaving its sessions with no credential.
 */
export function readsGrantedLogin(defaults: unknown): boolean {
  return (
    typeof defaults === "object" &&
    defaults !== null &&
    !Array.isArray(defaults) &&
    (defaults as Readonly<Record<string, unknown>>)[READS_GRANTED_LOGIN] ===
      true
  );
}
