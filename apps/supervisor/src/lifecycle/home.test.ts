import { SESSION_GIT_ENV } from "@bayon/executors";
import { expect, test } from "vitest";
import { buildEnv, type Credentials } from "./home.js";
import type { SessionPaths } from "./paths.js";
import type { SessionConfig } from "./profile.js";
import { DEFAULT_SETTINGS } from "./settings.js";

// buildEnv's agent identity: every session's GIT_AUTHOR_* and GIT_COMMITTER_* come from
// agents.git_author, so an agent's commit never carries the host's own user.
const paths: SessionPaths = {
  root: "/frm/work/S1",
  dir: "/frm/runtime/sessions/S1",
  home: "/frm/runtime/sessions/S1/home",
  tmp: "/frm/runtime/sessions/S1/tmp",
  logs: "/frm/runtime/sessions/S1/logs",
  prompts: "/frm/runtime/sessions/S1/prompts",
  rawLog: "/frm/runtime/sessions/S1/logs/raw.jsonl",
  remote: false,
};
const config: SessionConfig = {
  input: {},
  flags: {},
  env: { LANG: "C" },
  secretNames: [],
  secretAnyOf: [],
  hashInputs: [],
  baselineTokens: 0,
  toolAllowlist: [],
};
const ctx = {
  settings: DEFAULT_SETTINGS,
  path: "/usr/bin:/bin",
  homeTag: "tag",
};
/** No secrets and no grant, as resolveCredentials leaves a runner that names none. */
const none: Credentials = { secrets: [], granted: undefined };

test("every session commits as the install's agent identity, the default until one is set", async () => {
  expect(buildEnv(ctx, "S1", config, paths, none)).toEqual({
    GIT_AUTHOR_NAME: "Bayon Agent",
    GIT_AUTHOR_EMAIL: "agent@bayon.invalid",
    GIT_COMMITTER_NAME: "Bayon Agent",
    GIT_COMMITTER_EMAIL: "agent@bayon.invalid",
    LANG: "C",
    ...SESSION_GIT_ENV,
    HOME: paths.home,
    TMPDIR: paths.tmp,
    PATH: "/usr/bin:/bin",
    FRM_SESSION_ID: "S1",
    FRM_HOME_TAG: "tag",
  });
});

test("the setting's identity is used, and a profile's env may still set its own", async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    "agents.git_author": { name: "Fleet Bot", email: "bot@example.invalid" },
  };
  const own = { ...config, env: { GIT_AUTHOR_NAME: "Profile Bot" } };
  const env = buildEnv({ ...ctx, settings }, "S1", own, paths, none);
  expect(env).toMatchObject({
    GIT_AUTHOR_NAME: "Profile Bot",
    GIT_AUTHOR_EMAIL: "bot@example.invalid",
    GIT_COMMITTER_NAME: "Fleet Bot",
    GIT_COMMITTER_EMAIL: "bot@example.invalid",
  });
});

// git the model runs carries no flag of ours, so the floor rides in the env it inherits.
test("every session's git reads no system or global config and runs no hook, fsmonitor or helper", () => {
  const env = buildEnv(ctx, "S1", config, paths, none);
  expect(env).toMatchObject(SESSION_GIT_ENV);
  expect(env).toMatchObject({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
});

test("neither a profile's env nor a secret can hand the floor back, even past parseConfig's refusal", () => {
  const hostile = Object.fromEntries(
    Object.keys(SESSION_GIT_ENV).map((name) => [name, "from-the-profile"]),
  );
  const env = buildEnv(ctx, "S1", { ...config, env: hostile }, paths, {
    secrets: Object.entries(hostile),
    granted: undefined,
  });
  expect(env).toMatchObject(SESSION_GIT_ENV);
});
