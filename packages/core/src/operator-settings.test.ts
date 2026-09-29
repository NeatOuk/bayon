import { describe, expect, test } from "vitest";
import { ADMISSION_SETTING_KEYS, readAdmissionSettings } from "./admission.js";
import { healthLimits } from "./executor-health.js";
import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  OperatorSettingsPatch,
  checkOperatorSetting,
  isOperatorSettingKey,
  operatorSettingSchema,
  type OperatorSettingDef,
  type OperatorSettingKey,
} from "./operator-settings.js";

const defOf = (key: OperatorSettingKey): OperatorSettingDef =>
  OPERATOR_SETTINGS[key];
const accepts = (key: OperatorSettingKey, value: unknown) =>
  operatorSettingSchema(defOf(key)).safeParse(value).success;

describe("the whitelist", () => {
  test.each(OPERATOR_SETTING_KEYS)(
    "%s: its default, min and max pass; one past either bound does not",
    (key) => {
      const def = defOf(key);
      expect(accepts(key, def.default)).toBe(true);
      expect(accepts(key, def.min)).toBe(true);
      expect(accepts(key, def.max)).toBe(true);
      // offAtZero with min 1 makes min-1 the same as its off value (0), which is valid on purpose.
      if (!(def.offAtZero === true && def.min - 1 === 0)) {
        expect(accepts(key, def.min - 1)).toBe(false);
      }
      expect(accepts(key, def.max + 1)).toBe(false);
      expect(accepts(key, String(def.default))).toBe(false);
      expect(accepts(key, null)).toBe(false);
    },
  );

  test("a flag is 0 or 1 only, as 012 seeds it and the backup job reads it", () => {
    for (const key of OPERATOR_SETTING_KEYS.filter(
      (k) => defOf(k).unit === "flag",
    )) {
      expect(accepts(key, true)).toBe(false);
      expect(accepts(key, 0.5)).toBe(false);
    }
  });

  const JIRA_INTERVALS = [
    "jira.sync_interval_ms",
    "jira.quick_interval_ms",
  ] as const;

  test.each(JIRA_INTERVALS)(
    "%s is 0 (off) or 1 min to a day, nothing between",
    (key) => {
      expect(accepts(key, 0)).toBe(true);
      expect(accepts(key, 1)).toBe(false);
      expect(accepts(key, 59_999)).toBe(false);
      expect(accepts(key, 60_000)).toBe(true);
      expect(accepts(key, 60_000.5)).toBe(false);
      expect(accepts(key, 86_400_000)).toBe(true);
      expect(accepts(key, 86_400_001)).toBe(false);
    },
  );

  test("only the offAtZero settings take 0 below their minimum", () => {
    const offAtZero: readonly string[] = [
      ...JIRA_INTERVALS,
      "runners.update_check_hours",
    ];
    const others = OPERATOR_SETTING_KEYS.filter((k) => !offAtZero.includes(k));
    for (const k of others)
      if (defOf(k).min > 0) expect([k, accepts(k, 0)]).toEqual([k, false]);
  });

  test("whole numbers only, except a percentage", () => {
    expect(accepts("admission.recheck_ms", 5_000.5)).toBe(false);
    expect(accepts("backup.keep", 2.5)).toBe(false);
    expect(accepts("admission.disk_min_free_pct", 12.5)).toBe(true);
  });

  test("keeps out the keys with their own doors and both security controls", () => {
    expect(OPERATOR_SETTING_KEYS).toHaveLength(29);
    for (const key of [
      "fleet.paused",
      "budget.daily_cap_usd",
      "executors.untrusted_roles",
      "admission.require_certified",
      "gates.wall_clock_ms",
      "__proto__",
      "toString",
    ]) {
      expect(isOperatorSettingKey(key)).toBe(false);
    }
  });

  test("the M4 contract's defaults", () => {
    expect(
      Object.fromEntries(
        OPERATOR_SETTING_KEYS.map((k) => [k, defOf(k).default]),
      ),
    ).toEqual({
      "admission.recheck_ms": 5_000,
      "admission.disk_min_free_pct": 10,
      "watchdog.silent_ms": 1_800_000,
      "watchdog.retry_storm_count": 5,
      "watchdog.retry_storm_window_ms": 600_000,
      "watchdog.retry_storm_backoff_ms": 900_000,
      "watchdog.circuit_failed_runs": 3,
      "reconciler.command_requeue_ms": 300_000,
      "reconciler.command_max_attempts": 3,
      "worktree.recheck_ms": 3_600_000,
      "executor.clock_skew_max_ms": 5_000,
      "backup.enabled": 1,
      "backup.at_utc_hour": 3,
      "backup.keep": 14,
      "jira.sync_interval_ms": 900_000,
      // the quick pass, every minute.
      "jira.quick_interval_ms": 60_000,
      // ten minutes for a CI to report its first check.
      "qa.ci_grace_ms": 600_000,
      // every channel off, subscribed to every event kind; quiet hours off.
      "notify.poll_ms": 15_000,
      "notify.mac.enabled": 0,
      "notify.mac.events": 127,
      "notify.ntfy.enabled": 0,
      "notify.ntfy.events": 127,
      "notify.webhook.enabled": 0,
      "notify.webhook.events": 127,
      "notify.email.enabled": 0,
      "notify.email.events": 127,
      "notify.quiet_start_hour": -1,
      "notify.quiet_end_hour": -1,
      // the runner update check, daily by default; 0 turns it off.
      "runners.update_check_hours": 24,
    });
  });
});

describe("its readers accept every value it lets through", () => {
  const admissionRows = (bound: "min" | "max") =>
    new Map<string, unknown>([
      [ADMISSION_SETTING_KEYS.paused, 0],
      [ADMISSION_SETTING_KEYS.untrustedRoles, []],
      [ADMISSION_SETTING_KEYS.requireCertified, 1],
      ...(
        [
          "admission.recheck_ms",
          "admission.disk_min_free_pct",
          "watchdog.retry_storm_count",
          "watchdog.retry_storm_window_ms",
          "watchdog.retry_storm_backoff_ms",
        ] as const
      ).map((k) => [k, defOf(k)[bound]] as const),
    ]);

  test.each(["min", "max"] as const)("admission at every %s", (bound) => {
    expect(readAdmissionSettings(admissionRows(bound)).ok).toBe(true);
  });

  test.each(["min", "max"] as const)(
    "the health limits at every %s",
    (bound) => {
      const limits = healthLimits(
        new Map<string, unknown>(
          (
            [
              "executor.clock_skew_max_ms",
              "admission.disk_min_free_pct",
            ] as const
          ).map((k) => [k, defOf(k)[bound]]),
        ),
      );
      expect(limits.ok).toBe(true);
    },
  );
});

describe("PUT /settings' map", () => {
  test("names known keys only, at least one, each within its bounds", () => {
    expect(
      OperatorSettingsPatch.safeParse({ "admission.recheck_ms": 2_000 })
        .success,
    ).toBe(true);
    expect(OperatorSettingsPatch.safeParse({}).success).toBe(false);
    expect(
      OperatorSettingsPatch.safeParse({
        "admission.recheck_ms": 2_000,
        "fleet.paused": 1,
      }).success,
    ).toBe(false);
    expect(
      OperatorSettingsPatch.safeParse({ "backup.at_utc_hour": 24 }).success,
    ).toBe(false);
  });

  test("checkOperatorSetting: an unknown key and a bad value are validation, naming the key", () => {
    const unknown = checkOperatorSetting("executors.untrusted_roles", [
      "reviewer",
    ]);
    expect(unknown).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    if (!unknown.ok)
      expect(unknown.error.message).toContain("not an operator setting");
    const bad = checkOperatorSetting("backup.keep", 0);
    expect(bad).toMatchObject({ ok: false, error: { class: "validation" } });
    if (!bad.ok) expect(bad.error.message).toContain("backup.keep");
    expect(checkOperatorSetting("backup.keep", 7)).toEqual({
      ok: true,
      value: { key: "backup.keep", value: 7 },
    });
  });
});
