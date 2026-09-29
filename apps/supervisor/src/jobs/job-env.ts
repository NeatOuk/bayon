// The environment a script job hands to repo-declared code (§9.8, §14).
//
// A script job -- the mechanism behind `parity_check` and `lint_check` -- runs as the supervisor's
// own uid. `lint_check` then runs the *repository's* declared commands (`repos.install_cmd`,
// `repos.lint_cmd`), which resolve through a `package.json` script, a config file or a plugin the
// builder agent could have edited. The ticket's premise was that such code is handed the
// supervisor's `HOME`; it is not -- `buildEnv` (lifecycle/home.ts) sets `HOME` to the session's own
// private directory and `RESERVED_ENV` (lifecycle/profile.ts) stops a profile overriding it.
//
// But that guarantee was *inherited*, not *asserted*: one line of a function written for runner
// sessions, with no test that would fail if it went. This module turns it into both halves of a
// guarantee -- a precondition the job refuses to start without, and a floor that wins over whatever
// the parent environment happens to carry:
//
//   - `jobHome` recomputes where the session's home must be from `FRM_HOME` and `FRM_SESSION_ID`
//     and refuses to run repo code under any other `HOME`. If `buildEnv` ever stops setting it, the
//     gate fails loudly rather than linting with the supervisor's dotfiles in reach.
//   - `repoCommandEnv` *sets* `HOME`, `TMPDIR` and the four XDG base directories under that home,
//     rather than passing whatever arrived. `HOME` alone is not enough: `XDG_CONFIG_HOME` re-points
//     git -- and a good few linters -- at a directory outside the home even when `HOME` is right.
//   - and it lays `GIT_ENV_FLOOR` under repo code too. That floor reaches only the git
//     *we* invoke; a repo's own `git` call read `/etc/gitconfig`, and whatever `$HOME/.gitconfig`
//     the install command that ran thirty seconds earlier had just written.
//
// What this does NOT close: the job still runs as the supervisor's uid, so an absolute path reaches
// the supervisor's home regardless of any environment. Closing that needs an untrusted executor
// (§9.8), which needs a docker host. See the design.
import { join, resolve } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { GIT_ENV_FLOOR } from "@bayon/executors";
import { frmError } from "../lifecycle/errors.js";
import { sessionPaths } from "../lifecycle/paths.js";

/** Where one script job's repo-declared code may keep state: this session's own directories. */
export interface JobHome {
  /** `<FRM_HOME>/runtime/sessions/<id>/home`, created 0700 by makeSessionDirs. */
  readonly home: string;
  readonly tmp: string;
}

/**
 * The exact names a repo-declared command is given, when the environment holds them: what a
 * package manager and a linter need to find a toolchain, a cache and a locale, and nothing else.
 *
 * The lint command is a repo's own script, so it must not be handed `FRM_DB` (the path to the
 * system of record), `FRM_MCP_TOKEN` (a session's write credential) or anything else the supervisor
 * set for *its* job. A denylist of `FRM_`-prefixed names said that much and no more, and it was
 * sound only by accident: §14 injects a secret under its **store** name (`GH_TOKEN`, a provider's
 * own API-key name), which carries no prefix of ours, so the day a profile for this job claims one
 * it would land in repo-controlled code -- and in the finding tail that reaches the database if the
 * script printed it. Naming what goes in makes that structural instead of a review note
 * (Invariant 11).
 *
 * `HOME` and `TMPDIR` are deliberately absent: they are not passed, they are *set* by `ENV_FLOOR`
 * below. Neither are `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, which `buildEnv` puts in the session's env
 * for the agent that owns it -- a lint command has no business committing.
 */
export const REPO_ENV_NAMES: readonly string[] = [
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "TZ",
  "LANG",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // What a linter reads to turn colour and interactivity off.
  "CI",
];

/** …and the prefixes, for the families a package manager spells out per tool. */
export const REPO_ENV_PREFIXES: readonly string[] = [
  "LC_",
  "XDG_",
  "NODE_",
  "NPM_CONFIG_",
  "npm_config_",
  "PNPM_",
  "COREPACK_",
  "VOLTA_",
  "NVM_",
  "FNM_",
  "ASDF_",
];

/**
 * The names this module *sets*, overriding whatever the parent carried. The `XDG_` prefix above
 * would otherwise let an inherited `XDG_CONFIG_HOME` point a repo command's git, and its linters,
 * at a config directory outside the session home -- the exact shape of hole `HOME` alone leaves.
 *
 * `XDG_RUNTIME_DIR` is not here: it is the one XDG name a program may legitimately need to be the
 * host's (a session bus), it names no config or cache of ours, and it is a directory the supervisor
 * does not own and cannot create. It stays in the pass-through above.
 */
export function envFloor(at: JobHome): Readonly<Record<string, string>> {
  return {
    HOME: at.home,
    TMPDIR: at.tmp,
    XDG_CONFIG_HOME: join(at.home, ".config"),
    XDG_CACHE_HOME: join(at.home, ".cache"),
    XDG_DATA_HOME: join(at.home, ".local", "share"),
    XDG_STATE_HOME: join(at.home, ".local", "state"),
    ...GIT_ENV_FLOOR,
  };
}

/**
 * The environment one repo-declared command runs under: the allowlist over `parent`, then the floor
 * on top. The floor is applied last and unconditionally -- a floor a caller's environment could
 * take back is not a floor (the rule GIT_ENV_FLOOR already states, packages/executors/src/git.ts).
 */
export function repoCommandEnv(
  parent: Readonly<Record<string, string | undefined>>,
  at: JobHome,
): Record<string, string> {
  const allowed = Object.entries(parent).flatMap(([k, v]) =>
    v !== undefined &&
    (REPO_ENV_NAMES.includes(k) ||
      REPO_ENV_PREFIXES.some((p) => k.startsWith(p)))
      ? [[k, v] as const]
      : [],
  );
  return { ...Object.fromEntries(allowed), ...envFloor(at) };
}

/** What `jobHome` needs out of the job's own environment. */
const nonEmpty = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string => (env[name] ?? "").trim();

/**
 * This job's own home, recomputed from `FRM_HOME` and `FRM_SESSION_ID` and checked against the
 * `HOME` the supervisor handed it.
 *
 * The check is the point. `buildEnv` sets `HOME` to the session's private directory, so the value
 * inherited here is already right -- but it is right because of a line written for runner sessions,
 * and repo-controlled code is the last place to depend on a coincidence. Recomputing it means the
 * job refuses to run a repository's commands at all if the two ever disagree, rather than running
 * them wherever `HOME` happened to point.
 *
 * Both names are already required by the job's own env schema: `FRM_HOME` comes from the profile
 * (tools/frm/src/lint-config.ts) and `FRM_SESSION_ID` is one of the supervisor's reserved names.
 */
export function jobHome(
  env: Readonly<Record<string, string | undefined>>,
): Result<JobHome> {
  const frmHome = nonEmpty(env, "FRM_HOME");
  const sessionId = nonEmpty(env, "FRM_SESSION_ID");
  const home = nonEmpty(env, "HOME");
  const missing = [
    ...(frmHome === "" ? ["FRM_HOME"] : []),
    ...(sessionId === "" ? ["FRM_SESSION_ID"] : []),
    ...(home === "" ? ["HOME"] : []),
  ];
  if (missing.length > 0) {
    return err(
      frmError(
        "validation",
        `this job cannot run repository commands: its environment sets no ${missing.join(", ")}, so there is no session-private home to confine them to`,
      ),
    );
  }
  const paths = sessionPaths(frmHome, sessionId);
  if (resolve(home) !== resolve(paths.home)) {
    return err(
      frmError(
        "validation",
        `this job cannot run repository commands: its HOME is not session ${sessionId}'s own directory, so the commands would run with a home they do not own`,
      ),
    );
  }
  return ok({ home: paths.home, tmp: paths.tmp });
}
