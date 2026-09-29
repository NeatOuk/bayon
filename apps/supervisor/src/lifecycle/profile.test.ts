import {
  COMMAND_POLICY_FLAG,
  defaultCommandPolicy,
  hashConfig,
} from "@bayon/core";
import type { ProfileRow, RunnerRow } from "@bayon/db";
import { SESSION_GIT_ENV } from "@bayon/executors";
import { expect, test } from "vitest";
import { configInput, parseConfig } from "./profile.js";

// A pinned runner and profile. config_hash rules are permanent once runs are recorded (§8.1).
const runner: RunnerRow = {
  id: "fixture",
  kind: "script",
  adapter: "fixture",
  version_detected: "1",
  caps_json: "{}",
  defaults_json:
    '{"secretEnv":["API_KEY"],"hashInputs":["DOCTRINE.md"],"mode":"default"}',
  conformance_version: null,
  conformance_passed_at: null,
  conformance_report_path: null,
  gate_eligible: 0,
  enabled: 1,
  conformance_json: null,
};
const profile: ProfileRow = {
  id: "p1",
  name: "builder",
  runner_id: "fixture",
  model_tier: "standard",
  permission_json: '{"mode":"acceptEdits","allow":["Read"]}',
  sandbox_json: '{"network":false}',
  env_json: '{"LANG":"C"}',
  secret_refs_json: '["GH_TOKEN"]',
  mcp_json: "{}",
  hooks_json: "{}",
  skills_refs_json: "[]",
  tool_allowlist_json: '["tickets.read"]',
  version: 3,
  hash: "not-hashed",
  created_at: 1,
};
/** The same profile, stating no permissions: its role's default command policy applies. */
const unstated: ProfileRow = { ...profile, permission_json: "{}" };

async function hashOf(
  p = profile,
  r = runner,
  role = "builder",
): Promise<string> {
  const input = configInput(p, r, role);
  if (!input.ok) throw new Error(input.error.message);
  return hashConfig(input.value);
}

test("config_hash of a pinned profile is a golden value", async () => {
  expect(await hashOf()).toBe(
    "b8a323f0191a1448754faa8a50f3e8ee01b8d52eec3fc67cb659d4a4bb881bb9",
  );
});

test("key order, formatting and identity columns leave it; content changes it", async () => {
  const same = {
    ...profile,
    permission_json: '{ "allow": ["Read"],\n "mode": "acceptEdits" }',
    id: "p2",
    name: "other",
    version: 9,
    hash: "other",
    created_at: 99,
  };
  const golden = await hashOf();
  expect(await hashOf(same)).toBe(golden);
  const plan = {
    ...profile,
    permission_json: '{"mode":"plan","allow":["Read"]}',
  };
  expect(await hashOf(plan)).not.toBe(golden);
  const defaults = { ...runner, defaults_json: '{"mode":"other"}' };
  expect(await hashOf(profile, defaults)).not.toBe(golden);
  expect(await hashOf({ ...profile, model_tier: "cheap" })).not.toBe(golden);
});

test("flags merge runner defaults, permission and sandbox, the profile winning", () => {
  const config = parseConfig(profile, runner, "builder");
  if (!config.ok) throw new Error(config.error.message);
  expect(config.value).toMatchObject({
    flags: {
      secretEnv: ["API_KEY"],
      hashInputs: ["DOCTRINE.md"],
      mode: "acceptEdits",
      allow: ["Read"],
      network: false,
    },
    env: { LANG: "C" },
    secretNames: ["API_KEY", "GH_TOKEN"],
    hashInputs: ["DOCTRINE.md"],
  });
  // Secret names are hashed, never values: the store is not even consulted here.
  expect(JSON.stringify(config.value.input)).toContain("GH_TOKEN");
});

test("a profile's own permission_json keeps no default command policy, whatever the role", async () => {
  const config = parseConfig(profile, runner, "builder");
  if (!config.ok) throw new Error(config.error.message);
  expect(config.value.flags).not.toHaveProperty(COMMAND_POLICY_FLAG);
  expect(config.value.input).not.toHaveProperty("command_policy");
  expect(await hashOf(profile, runner, "reviewer")).toBe(await hashOf());
});

test("a profile with no permission_json gets its role's default policy, in its flags and its hash", async () => {
  const config = parseConfig(unstated, runner, "builder");
  if (!config.ok) throw new Error(config.error.message);
  const policy = defaultCommandPolicy("builder");
  expect(config.value.flags[COMMAND_POLICY_FLAG]).toEqual(policy);
  expect(config.value.input).toMatchObject({ command_policy: policy });
  // The hash covers the policy: the same profile hashes apart for a builder and an investigator.
  expect(await hashOf(unstated, runner, "builder")).not.toBe(
    await hashOf(unstated, runner, "investigator"),
  );
});

test("a role with no default policy gets none, and the profile's flags are as before", async () => {
  const config = parseConfig(unstated, runner, "orchestrator");
  if (!config.ok) throw new Error(config.error.message);
  expect(config.value.flags).not.toHaveProperty(COMMAND_POLICY_FLAG);
  expect(config.value.input).not.toHaveProperty("command_policy");
  expect(await hashOf(unstated, runner, "orchestrator")).toBe(
    await hashOf(unstated, runner, "conformance"),
  );
});

test("a reviewer's profile with no permission_json gets read-only git, in its flags and its hash", async () => {
  const config = parseConfig(unstated, runner, "reviewer");
  if (!config.ok) throw new Error(config.error.message);
  const policy = { role: "reviewer", groups: ["git_read"] };
  expect(config.value.flags[COMMAND_POLICY_FLAG]).toEqual(policy);
  expect(config.value.input).toMatchObject({ command_policy: policy });
  expect(await hashOf(unstated, runner, "reviewer")).not.toBe(
    await hashOf(unstated, runner, "orchestrator"),
  );
});

test("the profile's sandbox flags still win over the default policy's key", () => {
  const own = { ...unstated, sandbox_json: '{"commandPolicy":"theirs"}' };
  const config = parseConfig(own, runner, "builder");
  if (!config.ok) throw new Error(config.error.message);
  expect(config.value.flags[COMMAND_POLICY_FLAG]).toBe("theirs");
});

test.each([
  ["env_json", '{"HOME":"/elsewhere"}'],
  ["env_json", '{"PATH":"/bin"}'],
  ["secret_refs_json", '["FRM_SESSION_ID"]'],
  ["secret_refs_json", '["TMPDIR"]'],
  ["secret_refs_json", '["not a name"]'],
  ["env_json", "{"],
  ["permission_json", "[]"],
])("a profile with %s = %s is a validation error", (column, value) => {
  expect(
    parseConfig({ ...profile, [column]: value }, runner, "builder"),
  ).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

// the session's git floor is the supervisor's, name by name — refused, never overwritten.
test.each(Object.keys(SESSION_GIT_ENV))(
  "a profile that sets the git floor's %s is refused, naming it",
  (name) => {
    for (const column of ["env_json", "secret_refs_json"] as const) {
      const value =
        column === "env_json"
          ? JSON.stringify({ [name]: "x" })
          : JSON.stringify([name]);
      const refused = parseConfig(
        { ...profile, [column]: value },
        runner,
        "builder",
      );
      expect(refused).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
      expect(refused.ok ? "" : refused.error.message).toContain(name);
    }
  },
);

test("a one-of secret rule reaches the config in declared order, apart from secretNames", () => {
  const oneOf = {
    ...runner,
    defaults_json: '{"secretEnvAnyOf":[["KEY_A"],["TOKEN_B","TOKEN_C"]]}',
  };
  const config = parseConfig(profile, oneOf, "builder");
  if (!config.ok) throw new Error(config.error.message);
  expect(config.value.secretAnyOf).toEqual([["KEY_A"], ["TOKEN_B", "TOKEN_C"]]);
  expect(config.value.secretNames).toEqual(["GH_TOKEN"]);
  expect(parseConfig(profile, runner, "builder")).toMatchObject({
    ok: true,
    value: { secretAnyOf: [] },
  });
});

test.each([
  '{"secretEnvAnyOf":["KEY_A"]}',
  '{"secretEnvAnyOf":[[]]}',
  '{"secretEnvAnyOf":[["not a name"]]}',
  '{"secretEnvAnyOf":[["KEY_A"],["PATH"]]}',
])("runner defaults %s are a validation error", (defaults_json) => {
  expect(
    parseConfig(profile, { ...runner, defaults_json }, "builder"),
  ).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("the runner's session baseline reaches the config; none declared is 0", () => {
  const declared = {
    ...runner,
    defaults_json: '{"sessionBaselineTokens":20000}',
  };
  expect(parseConfig(profile, declared, "builder")).toMatchObject({
    ok: true,
    value: { baselineTokens: 20_000 },
  });
  expect(parseConfig(profile, runner, "builder")).toMatchObject({
    ok: true,
    value: { baselineTokens: 0 },
  });
});

test.each([
  '{"sessionBaselineTokens":-1}',
  '{"sessionBaselineTokens":1.5}',
  '{"sessionBaselineTokens":"20000"}',
])(
  "runner defaults %s are a validation error: a bad baseline is loud, never read as none",
  (defaults_json) => {
    expect(
      parseConfig(profile, { ...runner, defaults_json }, "builder"),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  },
);

test("runner defaults with a bad secretEnv are a validation error", () => {
  const bad = { ...runner, defaults_json: '{"secretEnv":"API_KEY"}' };
  expect(parseConfig(profile, bad, "builder")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});
