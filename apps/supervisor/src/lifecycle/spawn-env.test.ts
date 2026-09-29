// A spawn's own environment (InternalSpawn.env, an earlier change H1), validated and hashed by an earlier change.
// Pure over a parsed SessionConfig, so every refusal and the hash are testable without a fleet.
import { hashConfig } from "@bayon/core";
import { expect, test } from "vitest";
import type { SessionConfig } from "./profile.js";
import { withSpawnEnv } from "./resolve.js";

const PROFILE = "reviewer-profile";

const config = (o: Partial<SessionConfig> = {}): SessionConfig => ({
  input: { v: 1, runner: { id: "script", defaults: {} }, profile: {} },
  flags: {},
  env: { FRM_HOME: "/srv/frm" },
  secretNames: ["VENDOR_API_KEY"],
  secretAnyOf: [["VENDOR_OAUTH_TOKEN"]],
  hashInputs: [],
  baselineTokens: 0,
  toolAllowlist: [],
  ...o,
});

const unwrapConfig = (r: ReturnType<typeof withSpawnEnv>): SessionConfig => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

test("no env: the config and its hash input are untouched", async () => {
  const base = config();
  const same = unwrapConfig(withSpawnEnv(PROFILE, base, undefined));
  expect(same).toBe(base);
  // The point of the `undefined` branch: every session spawned before an earlier change keeps its
  // config_hash, so no adopt and no re-admission is invalidated by this change.
  expect(await hashConfig(same.input)).toBe(await hashConfig(base.input));
});

test("a good name is added to the child's env and to what config_hash hashes", async () => {
  const base = config();
  const withEnv = unwrapConfig(
    withSpawnEnv(PROFILE, base, { FRM_PARITY_HEAD: "a".repeat(40) }),
  );
  expect(withEnv.env).toEqual({
    FRM_HOME: "/srv/frm",
    FRM_PARITY_HEAD: "a".repeat(40),
  });
  expect(withEnv.input).toMatchObject({
    spawn_env: { FRM_PARITY_HEAD: "a".repeat(40) },
  });
  expect(await hashConfig(withEnv.input)).not.toBe(
    await hashConfig(base.input),
  );
});

// §8.1: before this, `config_hash` was the profile's, `prompt_hash` covered only the ticket line,
// `mission_hash` was null and `doctrine_hash` was constant for a session with no worktree — so two
// parity runs that examined different commits recorded identical input hashes.
test("two spawns that work on different commits do not hash alike", async () => {
  const base = config();
  const one = unwrapConfig(
    withSpawnEnv(PROFILE, base, { FRM_PARITY_HEAD: "a".repeat(40) }),
  );
  const two = unwrapConfig(
    withSpawnEnv(PROFILE, base, { FRM_PARITY_HEAD: "b".repeat(40) }),
  );
  expect(await hashConfig(one.input)).not.toBe(await hashConfig(two.input));
});

// adoptSpec rebuilds the child env from the profile alone (parseConfig) and gates the adopt on
// config_hash. With the spawn env in the hash that rebuild can never match, so the adopt is refused
// instead of resuming a child without the environment it was spawned with — which is the case the
// hash check exists to catch and the one it used to pass.
test("an adopt rebuilding from the profile alone cannot match a spawn that added env", async () => {
  const fromProfile = config();
  const atSpawn = unwrapConfig(
    withSpawnEnv(PROFILE, fromProfile, { FRM_PARITY_REPO_ID: "repo" }),
  );
  expect(await hashConfig(fromProfile.input)).not.toBe(
    await hashConfig(atSpawn.input),
  );
});

// buildEnv writes the reserved names, then the secrets, after config.env — so each of these was
// silently dropped rather than refused. Refusing is the right default for a field any job may use.
test.each<[string, Record<string, string>, string]>([
  [
    "a reserved name",
    { HOME: "/tmp/elsewhere" },
    "HOME is owned by the supervisor",
  ],
  [
    "the orphan scan's tag",
    { FRM_HOME_TAG: "forged" },
    "FRM_HOME_TAG is owned by the supervisor",
  ],
  [
    "the session's git floor",
    { GIT_CONFIG_GLOBAL: "/tmp/g" },
    "GIT_CONFIG_GLOBAL is owned by the supervisor",
  ],
  [
    "a config pair of the floor",
    { GIT_CONFIG_COUNT: "0" },
    "GIT_CONFIG_COUNT is owned by the supervisor",
  ],
  [
    "a malformed name",
    { "2BAD": "x" },
    "2BAD is not an environment variable name",
  ],
  [
    "a name with a hyphen",
    { "FRM-PARITY": "x" },
    "FRM-PARITY is not an environment variable name",
  ],
  [
    "a secret the profile declares",
    { VENDOR_API_KEY: "not-a-secret" },
    `VENDOR_API_KEY is a secret name of profile ${PROFILE}`,
  ],
  [
    "a name in the runner's one-of secret set",
    { VENDOR_OAUTH_TOKEN: "x" },
    `VENDOR_OAUTH_TOKEN is a secret name of profile ${PROFILE}`,
  ],
])("%s is refused, not dropped", (_what, env, detail) => {
  const refused = withSpawnEnv(PROFILE, config(), env);
  expect(refused).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(refused.ok ? "" : refused.error.message).toContain(detail);
});

test("every bad name is named at once, not one refusal at a time", () => {
  const refused = withSpawnEnv(PROFILE, config(), {
    HOME: "/tmp",
    "2BAD": "x",
    VENDOR_API_KEY: "y",
  });
  const message = refused.ok ? "" : refused.error.message;
  expect(message).toContain("2BAD");
  expect(message).toContain("HOME");
  expect(message).toContain("VENDOR_API_KEY");
});

test("a config input that is not an object is refused rather than spread", () => {
  const refused = withSpawnEnv(PROFILE, config({ input: [1, 2] }), {
    FRM_PARITY_HEAD: "a",
  });
  expect(refused).toMatchObject({ ok: false, error: { class: "validation" } });
});
