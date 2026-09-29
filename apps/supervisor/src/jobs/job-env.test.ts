import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GIT_ENV_FLOOR } from "@bayon/executors";
import { isReservedEnvName, qaSecretName } from "@bayon/core";
import { sessionPaths } from "../lifecycle/paths.js";
import { envFloor, jobHome, repoCommandEnv } from "./job-env.js";

// The environment a script job hands repo-declared code. These are the *unit* half:
// which names survive, and which are set regardless of what arrived. The half that matters --
// a real command actually failing to reach the supervisor's home -- is lint-run.test.ts and
// gates/lint-gate.test.ts, because a test that lists keys passes against a list missing one.

const FRM_HOME = "/frm";
const SESSION = "S1";
const PATHS = sessionPaths(FRM_HOME, SESSION);
const AT = { home: PATHS.home, tmp: PATHS.tmp };

/** What the supervisor's own process carries, as a job would have inherited it if anything did. */
const SUPERVISOR = {
  HOME: "/Users/op",
  TMPDIR: "/var/folders/op",
  XDG_CONFIG_HOME: "/Users/op/.config",
  XDG_CACHE_HOME: "/Users/op/.cache",
  XDG_DATA_HOME: "/Users/op/.local/share",
  XDG_STATE_HOME: "/Users/op/.local/state",
};

describe("repoCommandEnv", () => {
  test("only the names a toolchain needs survive: not the DB, not a token, not a secret", () => {
    const env = repoCommandEnv(
      {
        PATH: "/usr/bin",
        FRM_DB: "/frm/foreman.db",
        FRM_MCP_TOKEN: "secret",
        FRM_SESSION_ID: SESSION,
        // §14 injects a secret under its store name, which carries no prefix of ours.
        GH_TOKEN: "ghp_x",
        GIT_AUTHOR_NAME: "agent",
        UNSET: undefined,
        CI: "1",
        npm_config_registry: "https://r.example/",
        LC_ALL: "C",
      },
      AT,
    );
    expect(env["FRM_DB"]).toBeUndefined();
    expect(env["FRM_MCP_TOKEN"]).toBeUndefined();
    expect(env["FRM_SESSION_ID"]).toBeUndefined();
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["GIT_AUTHOR_NAME"]).toBeUndefined();
    expect(env["UNSET"]).toBeUndefined();
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      CI: "1",
      npm_config_registry: "https://r.example/",
      LC_ALL: "C",
    });
  });

  // The an earlier change fix itself. The old allowlist *passed* HOME, TMPDIR and the whole XDG_ family
  // through, so the confinement was whatever the parent happened to hold. These are set.
  test("the floor overrides a parent env carrying the supervisor's home", () => {
    const env = repoCommandEnv({ PATH: "/usr/bin", ...SUPERVISOR }, AT);
    for (const [name, value] of Object.entries(env)) {
      expect(`${name}=${value}`).not.toContain("/Users/op");
    }
    expect(env).toMatchObject({
      HOME: PATHS.home,
      TMPDIR: PATHS.tmp,
      XDG_CONFIG_HOME: join(PATHS.home, ".config"),
      XDG_CACHE_HOME: join(PATHS.home, ".cache"),
      XDG_DATA_HOME: join(PATHS.home, ".local", "share"),
      XDG_STATE_HOME: join(PATHS.home, ".local", "state"),
    });
  });

  // floor reaches only the git *we* invoke. A repo's own `git` call read the host's
  // system config, and whatever ~/.gitconfig the install command had just written.
  test("git's env floor is laid under repo code too, and a parent cannot take it back", () => {
    expect(
      repoCommandEnv(
        { GIT_CONFIG_GLOBAL: "/Users/op/.gitconfig", GIT_CONFIG_NOSYSTEM: "0" },
        AT,
      ),
    ).toMatchObject(GIT_ENV_FLOOR);
  });

  // XDG_RUNTIME_DIR names no config or cache of ours, is the host's by definition, and is not a
  // directory the supervisor can create: it stays a pass-through while its four siblings are set.
  test("XDG_RUNTIME_DIR still passes through", () => {
    expect(
      repoCommandEnv({ XDG_RUNTIME_DIR: "/run/user/501" }, AT)[
        "XDG_RUNTIME_DIR"
      ],
    ).toBe("/run/user/501");
  });
});

describe("jobHome", () => {
  test("the session's own home, recomputed from FRM_HOME and the session id", () => {
    const at = jobHome({
      FRM_HOME,
      FRM_SESSION_ID: SESSION,
      HOME: PATHS.home,
    });
    expect(at.ok && at.value).toEqual(AT);
  });

  // The guarantee this module exists to stop depending on: HOME is the session's because of one
  // line of buildEnv. If that ever changes, the gate fails here rather than linting under the
  // supervisor's dotfiles.
  test("a HOME that is not this session's refuses to run anything", () => {
    for (const HOME of ["/Users/op", sessionPaths(FRM_HOME, "S2").home, ""]) {
      const at = jobHome({ FRM_HOME, FRM_SESSION_ID: SESSION, HOME });
      expect(at.ok, HOME).toBe(false);
      if (!at.ok) expect(at.error.class).toBe("validation");
    }
  });

  test("a missing name is named in the message, not assumed", () => {
    const at = jobHome({ HOME: PATHS.home });
    expect(at.ok).toBe(false);
    if (!at.ok) {
      expect(at.error.message).toContain("FRM_HOME");
      expect(at.error.message).toContain("FRM_SESSION_ID");
    }
  });

  test("a trailing slash or a relative segment is still this session's home", () => {
    const at = jobHome({
      FRM_HOME,
      FRM_SESSION_ID: SESSION,
      HOME: join(PATHS.home, "x", ".."),
    });
    expect(at.ok).toBe(true);
  });
});

// `envFloor` is applied last, deliberately, so a QA secret named one of its keys is
// silently thrown away — the harness would run with foreman's value and the failure would read as a
// broken credential. `qaSecretName` refuses those names at the door, from a list core restates
// because core may not import this app. This is what stops the two drifting: a name added to the
// floor and missed there becomes a secret an operator can set and never receive.
test("every name the floor sets is a name a QA secret may not take", () => {
  const floor = Object.keys(envFloor({ home: "/h", tmp: "/t" }));
  expect(floor.length).toBeGreaterThan(0);
  for (const name of floor) {
    // Only the ones that look like a secret name at all: the floor sets no others today, and a
    // lower-case one could never be a QA secret anyway (QA_SECRET_NAME refuses it).
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    expect(isReservedEnvName(name), name).toBe(true);
    expect(qaSecretName(name).ok, name).toBe(false);
  }
  // And the git floor's own names, since envFloor spreads them in.
  for (const name of Object.keys(GIT_ENV_FLOOR)) {
    expect(isReservedEnvName(name), name).toBe(true);
  }
});
