import { expect, test } from "vitest";
import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  isOperatorSettingKey,
} from "./operator-settings.js";
import { LOGIN_IN_PLACE_KEY } from "./login-in-place.js";
import { WORK_ROLES } from "./roles.js";
import {
  REQUIRE_CERTIFIED_KEY,
  checkSeededSetting,
  isShellOnlySettingKey,
} from "./seeded-settings.js";

const refused = { ok: false, error: { class: "validation" } };

test("fleet.paused is never seeded, whatever the value", () => {
  for (const value of [0, 1, true]) {
    const r = checkSeededSetting("fleet.paused", value);
    expect(r).toMatchObject(refused);
    if (!r.ok) expect(r.error.message).toContain("frm pause");
  }
});

test.each(OPERATOR_SETTING_KEYS)(
  "%s is governed: its default passes, a value past its bounds is refused as PUT refuses it",
  (key) => {
    const def = OPERATOR_SETTINGS[key];
    expect(checkSeededSetting(key, def.default)).toEqual({
      ok: true,
      value: "governed",
    });
    expect(checkSeededSetting(key, def.max + 1)).toMatchObject(refused);
    expect(checkSeededSetting(key, String(def.default))).toMatchObject(refused);
  },
);

test("the security controls are shell-only: never whitelisted, and a seed of one is checked", () => {
  for (const key of [REQUIRE_CERTIFIED_KEY, "executors.untrusted_roles"]) {
    expect(isOperatorSettingKey(key)).toBe(false);
    expect(isShellOnlySettingKey(key)).toBe(true);
  }
  for (const value of [0, 1])
    expect(checkSeededSetting(REQUIRE_CERTIFIED_KEY, value)).toEqual({
      ok: true,
      value: "governed",
    });
  for (const value of [true, "1", 2])
    expect(checkSeededSetting(REQUIRE_CERTIFIED_KEY, value)).toMatchObject(
      refused,
    );
  expect(
    checkSeededSetting("executors.untrusted_roles", ["investigator"]),
  ).toEqual({ ok: true, value: "governed" });
  for (const value of ["investigator", [""], null])
    expect(
      checkSeededSetting("executors.untrusted_roles", value),
    ).toMatchObject(refused);
});

test("a string that is no role is refused wherever the untrusted roles are written", () => {
  // The schema used to ask for any non-empty string, so all three doors took one. trustRefusal
  // matches the spawn's role exactly (trust.ts), so "REVIEWER" or " builder " does not loosen the
  // isolation boundary — it empties it, while `frm settings get` still shows a plausible list and
  // admission logs no refusal. One schema, so every door inherits the check.
  for (const value of [
    ["reviewr"],
    ["REVIEWER"],
    [" builder "],
    ["investigator", "auditor"],
    ["conformance"], // a probe's role, never a work role
  ])
    expect(
      checkSeededSetting("executors.untrusted_roles", value),
    ).toMatchObject(refused);
  for (const role of WORK_ROLES)
    expect(checkSeededSetting("executors.untrusted_roles", [role])).toEqual({
      ok: true,
      value: "governed",
    });
});

test("the agents' git identity is shell-only and checked: `Name <email>` passes, anything else is refused", () => {
  expect(isOperatorSettingKey("agents.git_author")).toBe(false);
  expect(isShellOnlySettingKey("agents.git_author")).toBe(true);
  expect(
    checkSeededSetting(
      "agents.git_author",
      "Bayon Agent <agent@bayon.invalid>",
    ),
  ).toEqual({ ok: true, value: "governed" });
  for (const value of ["Bayon Agent", "", null, { name: "x" }])
    expect(checkSeededSetting("agents.git_author", value)).toMatchObject(
      refused,
    );
});

test.each(["lifecycle.kill_grace_ms", "x.object", "__proto__", "toString"])(
  "%s is written as it comes: not governed",
  (key) => {
    expect(checkSeededSetting(key, { any: "value" })).toEqual({
      ok: true,
      value: "plain",
    });
  },
);

test("the login grants are shell-only and checked: runner ids and absolute paths, or nothing", () => {
  expect(isOperatorSettingKey(LOGIN_IN_PLACE_KEY)).toBe(false);
  expect(isShellOnlySettingKey(LOGIN_IN_PLACE_KEY)).toBe(true);
  // Off is the default and `{}` says it: no runner, no path, nothing read.
  for (const value of [{}, { "a-runner": "/home/op/.x/auth.json" }])
    expect(checkSeededSetting(LOGIN_IN_PLACE_KEY, value)).toEqual({
      ok: true,
      value: "governed",
    });
  for (const value of [
    1,
    null,
    "on",
    ["a-runner"],
    { "a-runner": "auth.json" }, // relative
    { "a-runner": "/home/op/../op/auth.json" }, // .. segment
    { "a-runner": "/home/op/./auth.json" }, // . segment
    { "a-runner": "" },
    { "a-runner": "/" },
    { "A Runner": "/home/op/auth.json" },
    { "a-runner": 1 },
  ])
    expect(checkSeededSetting(LOGIN_IN_PLACE_KEY, value)).toMatchObject(
      refused,
    );
});
