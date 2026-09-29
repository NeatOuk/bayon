import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  type OperatorSettingKey,
} from "@bayon/core";
import type { OperatorSettingView } from "@bayon/proto";
import { expect, test } from "vitest";
import {
  checkDraft,
  draftOf,
  expected,
  formatMs,
} from "@/settings/settings-form";

const settings: OperatorSettingView[] = OPERATOR_SETTING_KEYS.map((key) => ({
  key,
  value: OPERATOR_SETTINGS[key].default,
  valid: true,
  default: OPERATOR_SETTINGS[key].default,
  updated_at: 1,
}));
const with_ = (over: Partial<Record<OperatorSettingKey, string>>) => ({
  ...draftOf(settings),
  ...over,
});

test.each([
  [250, "250 ms"],
  [5_000, "5 s"],
  [1_500, "1.5 s"],
  [600_000, "10 min"],
  [3_600_000, "1 h"],
  [5_400_000, "1 h 30 min"],
])("formatMs(%d) is %s", (ms, text) => {
  expect(formatMs(ms)).toBe(text);
});

test("the draft as the server has it is no change", () => {
  expect(checkDraft(draftOf(settings), settings)).toEqual({
    ok: true,
    patch: null,
  });
  expect(checkDraft(with_({ "backup.keep": " 14 " }), settings)).toEqual({
    ok: true,
    patch: null,
  });
});

test("changed keys only, as numbers; a fractional percentage is fine", () => {
  expect(
    checkDraft(
      with_({
        "admission.recheck_ms": "2000",
        "admission.disk_min_free_pct": "12.5",
        "backup.enabled": "0",
      }),
      settings,
    ),
  ).toEqual({
    ok: true,
    patch: {
      "admission.recheck_ms": 2_000,
      "admission.disk_min_free_pct": 12.5,
      "backup.enabled": 0,
    },
  });
});

test("an empty field, a value out of bounds and a fraction where whole numbers belong are refused", () => {
  expect(
    checkDraft(
      with_({
        "admission.recheck_ms": "",
        "backup.at_utc_hour": "24",
        "backup.keep": "2.5",
      }),
      settings,
    ),
  ).toEqual({
    ok: false,
    errors: {
      "admission.recheck_ms": "Enter a value.",
      "backup.at_utc_hour": "Enter a whole number from 0 to 23.",
      "backup.keep": "Enter a whole number from 1 to 1000.",
    },
  });
});

test("the refusal names the unit", () => {
  expect(expected(OPERATOR_SETTINGS["admission.recheck_ms"])).toBe(
    "Enter a whole number from 500 to 600000 ms.",
  );
  expect(expected(OPERATOR_SETTINGS["admission.disk_min_free_pct"])).toBe(
    "Enter a number from 0 to 50 %.",
  );
  expect(expected(OPERATOR_SETTINGS["jira.sync_interval_ms"])).toBe(
    "Enter a whole number from 60000 to 86400000 ms, or 0 for off.",
  );
  expect(expected(OPERATOR_SETTINGS["jira.quick_interval_ms"])).toBe(
    "Enter a whole number from 60000 to 86400000 ms, or 0 for off.",
  );
});

test("the Jira interval takes 0 for off, and nothing else below a minute", () => {
  expect(checkDraft(with_({ "jira.sync_interval_ms": "0" }), settings)).toEqual(
    { ok: true, patch: { "jira.sync_interval_ms": 0 } },
  );
  expect(
    checkDraft(with_({ "jira.sync_interval_ms": "1000" }), settings),
  ).toEqual({
    ok: false,
    errors: {
      "jira.sync_interval_ms":
        "Enter a whole number from 60000 to 86400000 ms, or 0 for off.",
    },
  });
});
