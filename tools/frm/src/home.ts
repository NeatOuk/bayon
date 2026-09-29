// Which home an frm command runs on: $FRM_HOME, else $FRM_DB, else the account's default install,
// `~/.foreman` (the same default the Keychain scope names the live install). Only main.ts calls this,
// for the commands that open a database; every run function keeps taking the env it is given, so a
// unit test passing `env: {}` still gets "set FRM_HOME" and never the operator's real home.
//
// The guard: FRM_NO_DEFAULT_HOME refuses the default. vitest.setup.ts sets it for every test worker
// and every child a test spawns, and `frm smoke` for its own children, so neither can fall through
// onto the live install.
import { userInfo } from "node:os";
import { err, ok, type Result } from "@bayon/core";
import {
  NO_DEFAULT_HOME_ENV,
  defaultHome as accountHome,
} from "@bayon/executors";

/** One name for the guard, shared with installHome in packages/executors. */
export { NO_DEFAULT_HOME_ENV };

type Env = Readonly<Record<string, string | undefined>>;

export interface HomeEnv {
  /** The env the command runs with: the one given, plus FRM_HOME when it was defaulted. */
  readonly env: Env;
  /** The default home, when it was used; null when the env named one. */
  readonly defaulted: string | null;
}

export interface HomeOptions {
  /** Tests only: the account's default home. */
  readonly defaultHome?: () => string;
  /** Tests only: where the guard is read besides `env` (default the process's own env). */
  readonly guard?: Env;
}

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== "";

export function homeEnvOf(env: Env, o: HomeOptions = {}): Result<HomeEnv> {
  if (isSet(env["FRM_HOME"]) || isSet(env["FRM_DB"]))
    return ok({ env, defaulted: null });
  const guard = o.guard ?? process.env;
  if (isSet(env[NO_DEFAULT_HOME_ENV]) || isSet(guard[NO_DEFAULT_HOME_ENV])) {
    return err({
      class: "validation",
      message: `set FRM_HOME (or FRM_DB): ${NO_DEFAULT_HOME_ENV} is set, so the default ~/.foreman is not used`,
      retryable: false,
    });
  }
  const home = (o.defaultHome ?? accountHome)();
  return ok({ env: { ...env, FRM_HOME: home }, defaulted: home });
}

/** The home as the operator would type it: the login home shown as `~`. */
export function shownHome(
  home: string,
  loginHome: string = userInfo().homedir,
): string {
  return home === loginHome || home.startsWith(`${loginHome}/`)
    ? `~${home.slice(loginHome.length)}`
    : home;
}
