import { mkdir } from "node:fs/promises";
import {
  AGENT_GIT_AUTHOR_KEY,
  LOGIN_IN_PLACE_KEY,
  LoginInPlace,
  READS_GRANTED_LOGIN,
  err,
  gitIdentityEnv,
  loginPathFor,
  ok,
  type FrmError,
  type Result,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { readLiveLogin, SESSION_GIT_ENV } from "@bayon/executors";
import type { SpawnSpec } from "@bayon/runners";
import { z } from "zod";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";
import type { SessionPaths } from "./paths.js";
import type { SessionConfig } from "./profile.js";
import { resolveSecrets, type SecretStore } from "./secrets.js";

/** runtime/sessions/<id>/{home, tmp, logs, prompts}, private to the operator (§11.3). A remote
 * session's home and tmp are its executor's: the workspace step makes them there. */
export async function makeSessionDirs(
  paths: SessionPaths,
): Promise<Result<void>> {
  const dirs = paths.remote
    ? [paths.logs, paths.prompts]
    : [paths.home, paths.tmp, paths.logs, paths.prompts];
  try {
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    return ok(undefined);
  } catch (e) {
    return err(
      frmError("spawn_failed", `cannot create ${paths.dir}`, String(e)),
    );
  }
}

/** A login the operator granted a runner, as the spawn hands it to the adapter (§14). */
export type GrantedLogin = NonNullable<SpawnSpec["grantedLogin"]>;

/**
 * The login file the operator granted `runnerId`, read from disk, or `undefined` when they granted
 * none — the default, and the only state in which any of this touches a file in their home. Consent
 * is `settings.runners.login_in_place`, shell-only through the operator door (§9.5), read fresh at
 * every process start (a spawn, an adopt, a conformance session's) so a revocation takes effect at
 * the next one rather than at the next boot, and a rotation written back is what the next one gets.
 *
 * A grant whose file is missing, unreadable, empty, oversized, a symlink or wrongly moded is
 * refused here, naming the setting, the runner and the path: the credential is the one thing a
 * session cannot start without, and this is the last moment the cause is still legible. What cannot
 * be judged here is whether the token inside is still live — only the provider knows that.
 */
export async function grantedLoginFor(
  db: Db,
  runnerId: string,
): Promise<Result<GrantedLogin | undefined>> {
  const path = await grantedPathFor(db, runnerId);
  if (!path.ok) return path;
  return path.value === undefined
    ? ok(undefined)
    : loginAt(runnerId, path.value);
}

/** The path `settings.runners.login_in_place` grants `runnerId`, without reading it. */
async function grantedPathFor(
  db: Db,
  runnerId: string,
): Promise<Result<string | undefined>> {
  const rows = await getSettings(db, [LOGIN_IN_PLACE_KEY]);
  if (!rows.ok) return rows;
  const stored = rows.value.get(LOGIN_IN_PLACE_KEY);
  if (stored === undefined) return ok(undefined);
  const grants = LoginInPlace.safeParse(stored);
  if (!grants.success) {
    return err(
      frmError(
        "validation",
        `${LOGIN_IN_PLACE_KEY} is not a map of runner id to absolute path: ${z.prettifyError(grants.error)}`,
      ),
    );
  }
  return ok(loginPathFor(grants.data, runnerId));
}

/** The granted login at `path`, read from disk, or the refusal naming the setting, runner and path. */
function loginAt(runnerId: string, path: string): Result<GrantedLogin> {
  const login = readLiveLogin(path);
  return login.ok
    ? ok({ path, value: login.value.text, mode: login.value.mode })
    : err(
        frmError(
          "validation",
          `${LOGIN_IN_PLACE_KEY} grants ${runnerId} the login at ${path}, and it cannot be used: ${login.error.message}`,
        ),
      );
}

/**
 * A grant to a runner whose registration does not declare that it reads one. Only an
 * adapter that places the file can use it; honouring it anyway would drop the runner's one-of and
 * start its sessions with no credential at all, each turn failing on an auth error that never
 * mentions the grant.
 */
const unreadableGrant = (runnerId: string): FrmError =>
  frmError(
    "validation",
    `${LOGIN_IN_PLACE_KEY} grants ${runnerId} a login, and ${runnerId} cannot read a login in place: ` +
      `only a runner that declares ${READS_GRANTED_LOGIN} can. Revoke it with ` +
      `frm settings set ${LOGIN_IN_PLACE_KEY} <the other grants, or none> --yes`,
  );

/** A runner's credentials, as every process it starts takes them (§14). Never logged. */
export interface Credentials {
  /** The secret-store values the child's env carries, by name. */
  readonly secrets: readonly (readonly [string, string])[];
  /** The login the operator granted this runner in place, when they did (§14). Never in `secrets`. */
  readonly granted: GrantedLogin | undefined;
}

/**
 * The one place a runner's credentials are decided: the grant first, then the secret
 * store. Every named secret is required; the runner's one-of alternatives are required only when
 * the operator granted no login, since a grant is the credential and requiring them anyway is what
 * forces the second, rotting copy it replaces. A grant that cannot be used refuses, naming the
 * setting, the runner and the path, and never falls back to the store: that fallback would make
 * the grant unprovable. A grant to a runner that does not declare it reads one is refused before
 * its file is read. A session's spawn and adopt call this, and so does a conformance
 * run — two paths that once decided apart, so a grant-only runner passed one and failed the other.
 */
export async function resolveCredentials(
  ctx: { readonly db: Db; readonly secrets: SecretStore },
  runnerId: string,
  names: Pick<
    SessionConfig,
    "secretNames" | "secretAnyOf" | "readsGrantedLogin"
  >,
): Promise<Result<Credentials>> {
  const path = await grantedPathFor(ctx.db, runnerId);
  if (!path.ok) return path;
  if (path.value !== undefined && names.readsGrantedLogin !== true) {
    return err(unreadableGrant(runnerId));
  }
  const granted =
    path.value === undefined ? ok(undefined) : loginAt(runnerId, path.value);
  if (!granted.ok) return granted;
  const secrets = await resolveSecrets(
    ctx.secrets,
    names.secretNames,
    granted.value === undefined ? names.secretAnyOf : [],
  );
  if (!secrets.ok) return secrets;
  return ok({ secrets: secrets.value, granted: granted.value });
}

/**
 * The child's complete environment: the agents' git identity (agents.git_author), then
 * the profile's env, which may set its own, then its secrets as `resolveCredentials` chose them,
 * then the git floor every git the model runs inherits (SESSION_GIT_ENV, an earlier change: no system or
 * global config, hook, fsmonitor, credential helper or askpass), then HOME, TMPDIR, PATH (its
 * executor's, when that is not the supervisor's), FRM_SESSION_ID and FRM_HOME_TAG last (§11.3): by
 * those two tags the orphan scan finds its processes. A granted login is not in it:
 * it rides on SpawnSpec.grantedLogin. Never logged (§14).
 */
export function buildEnv(
  ctx: Pick<Ctx, "settings" | "path" | "homeTag">,
  sessionId: string,
  config: SessionConfig,
  paths: SessionPaths,
  credentials: Credentials,
): Readonly<Record<string, string>> {
  return {
    ...gitIdentityEnv(ctx.settings[AGENT_GIT_AUTHOR_KEY]),
    ...config.env,
    ...Object.fromEntries(credentials.secrets),
    // After the profile and the secrets: RESERVED_ENV refuses these names there, and neither could
    // hand the host's git config back if it did not.
    ...SESSION_GIT_ENV,
    HOME: paths.home,
    TMPDIR: paths.tmp,
    PATH: paths.path ?? ctx.path,
    FRM_SESSION_ID: sessionId,
    FRM_HOME_TAG: ctx.homeTag,
  };
}

/** The spec as its executor's programs reach the world: one implementation, shared with the
 * conformance suite. */
export { applyPrepared } from "@bayon/runners";

/**
 * What ingest redacts from this process's records (Invariant 11): its MCP token and every secret
 * value its env holds. Values stay in memory; this list is never logged.
 */
export function redactionList(
  spec: SpawnSpec,
  config: SessionConfig,
): string[] {
  const names = [...config.secretNames, ...config.secretAnyOf.flat()];
  // A granted login never enters the env, so it has to be named here to get the same treatment; nor
  // does the context proxy's bearer (spec M12), which the adapter hands its runner itself.
  const values = [
    spec.mcp?.token,
    spec.grantedLogin?.value,
    spec.contextCompression?.token,
    ...names.map((name) => spec.env[name]),
  ];
  return [
    ...new Set(values.filter((v): v is string => v !== undefined && v !== "")),
  ];
}
