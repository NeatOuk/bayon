import { expect, test } from "vitest";
import {
  GATE_SETTING_KEYS,
  UNTRUSTED_ROLES_KEY,
  UntrustedRoles,
  readGateSettings,
} from "./settings.js";

// The values 007_gates seeds; seed.test.ts in packages/db checks the rows themselves.
const SEEDED = new Map<string, unknown>([
  [GATE_SETTING_KEYS.wall_clock_ms, 900_000],
  [GATE_SETTING_KEYS.blocking_severities, ["blocker", "major"]],
  [GATE_SETTING_KEYS.base_drift, "fail"],
  // 008_gate_retries.
  [GATE_SETTING_KEYS.timeout_retries, 1],
  // 020_parity_check: off until an operator turns it on.
  [GATE_SETTING_KEYS.parity_check, false],
  // 024_lint_check: the same, for the same reason.
  [GATE_SETTING_KEYS.lint_check, false],
  // 052_drift_rounds_max.
  [GATE_SETTING_KEYS.drift_rounds_max, 3],
  [UNTRUSTED_ROLES_KEY, ["investigator"]],
]);

test("the seeded settings read as GateSettings", () => {
  expect(readGateSettings(SEEDED)).toEqual({
    ok: true,
    value: {
      wall_clock_ms: 900_000,
      blocking_severities: ["blocker", "major"],
      base_drift: "fail",
      timeout_retries: 1,
      parity_check: false,
      lint_check: false,
      drift_rounds_max: 3,
    },
  });
  expect(UntrustedRoles.parse(SEEDED.get(UNTRUSTED_ROLES_KEY))).toEqual([
    "investigator",
  ]);
});

test.each<[string, string, unknown]>([
  ["a missing row", GATE_SETTING_KEYS.wall_clock_ms, undefined],
  ["an unknown severity", GATE_SETTING_KEYS.blocking_severities, ["critical"]],
  ["an unknown drift policy", GATE_SETTING_KEYS.base_drift, "ignore"],
  // 020 seeds it, so a missing row is a config error like the rest -- never a silent default.
  ["a missing parity_check row", GATE_SETTING_KEYS.parity_check, undefined],
  ["a non-boolean parity_check", GATE_SETTING_KEYS.parity_check, "yes"],
  // 024 seeds it too, so the same holds.
  ["a missing lint_check row", GATE_SETTING_KEYS.lint_check, undefined],
  ["a non-boolean lint_check", GATE_SETTING_KEYS.lint_check, "yes"],
  // 052 seeds it.
  [
    "a missing drift_rounds_max row",
    GATE_SETTING_KEYS.drift_rounds_max,
    undefined,
  ],
  ["a zero drift_rounds_max", GATE_SETTING_KEYS.drift_rounds_max, 0],
])("%s is a validation error, never a default", (_, key, value) => {
  const rows = new Map(SEEDED);
  if (value === undefined) rows.delete(key);
  else rows.set(key, value);
  expect(readGateSettings(rows)).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining("gate settings"),
    },
  });
});
