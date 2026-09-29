// A conformance run's credentials (§14, §15). A run is real sessions against a real
// model, so it takes its credentials exactly as a session does, from lifecycle's
// `resolveCredentials`: the operator's granted login when they consented to one, else the host
// secret store. It once resolved them on its own, from the store alone, so a runner whose login
// was granted in place and not also copied into the store had working sessions and a failing
// conformance run, and with `admission.require_certified` that locked the runner out.
import {
  LOGIN_IN_PLACE_KEY,
  err,
  ok,
  readsGrantedLogin,
  type FrmError,
  type Result,
} from "@bayon/core";
import { getRunner, type Db } from "@bayon/db";
import { SESSION_GIT_ENV } from "@bayon/executors";
import type { ConformanceSubject } from "@bayon/runners/conformance";
import { z } from "zod";
import { frmError } from "../lifecycle/errors.js";
import {
  grantedLoginFor,
  resolveCredentials,
  type GrantedLogin,
} from "../lifecycle/home.js";
import type { SecretStore } from "../lifecycle/secrets.js";

const Defaults = z.looseObject({
  secretEnv: z.array(z.string()).optional(),
  secretEnvAnyOf: z.array(z.array(z.string()).min(1)).optional(),
});

/**
 * The secrets a runner row's defaults name, none when they are not JSON or name none, and whether
 * it reads a login granted in place (core's reader, as a session's config takes it).
 */
function defaultsOf(
  text: string,
): z.infer<typeof Defaults> & { readonly readsGrantedLogin: boolean } {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { readsGrantedLogin: false };
  }
  const parsed = Defaults.safeParse(json);
  return {
    ...(parsed.success ? parsed.data : {}),
    readsGrantedLogin: readsGrantedLogin(json),
  };
}

export interface SuiteCredentials {
  /**
   * The child's env as a spawn builds it: the secrets its runner's defaults name, the session git
   * floor — a certification run's model runs the git a real session's does — and PATH.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Every credential value the run holds, redacted from every record (Invariant 11). */
  readonly redact: readonly string[];
  /** The granted login, re-read at each process start; absent when the operator granted none. */
  readonly grantedLogin?: ConformanceSubject["grantedLogin"];
}

/** Consent withdrawn between the run's start and one of its sessions: that session cannot start. */
const revoked = (runnerId: string): FrmError =>
  frmError(
    "validation",
    `${LOGIN_IN_PLACE_KEY} no longer grants ${runnerId} a login: consent was withdrawn during the run`,
  );

/**
 * The run's credentials for `runnerId`, `path` its PATH. A grant that cannot be used, or one to a
 * runner that cannot read a login in place, refuses the run before anything starts, naming the
 * setting and the runner; it never falls back to the store. With a grant, each session reads it again as it starts (a session's spawn does the
 * same), so a rotation the adapter wrote back is what the next session gets.
 */
export async function suiteCredentials(
  o: { readonly db: Db; readonly secrets: SecretStore },
  runnerId: string,
  path: string,
): Promise<Result<SuiteCredentials>> {
  const runner = await getRunner(o.db, runnerId);
  if (!runner.ok) return runner;
  const d = defaultsOf(runner.value.defaults_json);
  const credentials = await resolveCredentials(o, runnerId, {
    secretNames: d.secretEnv ?? [],
    secretAnyOf: d.secretEnvAnyOf ?? [],
    readsGrantedLogin: d.readsGrantedLogin,
  });
  if (!credentials.ok) return credentials;
  const { secrets, granted } = credentials.value;
  const env = {
    ...Object.fromEntries(secrets),
    ...SESSION_GIT_ENV,
    PATH: path,
  };
  const values = secrets.map(([, value]) => value);
  if (granted === undefined) return ok({ env, redact: values });
  const reread = async (): Promise<Result<GrantedLogin>> => {
    const now = await grantedLoginFor(o.db, runnerId);
    if (!now.ok) return now;
    return now.value === undefined ? err(revoked(runnerId)) : ok(now.value);
  };
  return ok({
    env,
    redact: [...values, granted.value],
    grantedLogin: reread,
  });
}
