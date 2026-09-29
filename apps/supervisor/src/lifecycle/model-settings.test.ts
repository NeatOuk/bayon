import { expect, test } from "vitest";
import { modelSettingsOf } from "./model-settings.js";

test("a row's settings ride as modelSettings; none, or {}, add nothing", () => {
  expect(
    modelSettingsOf({
      id: "m",
      settings_json: '{"provider_url":"http://10.0.0.7:1/v1"}',
    }),
  ).toEqual({
    ok: true,
    value: { modelSettings: { provider_url: "http://10.0.0.7:1/v1" } },
  });
  expect(modelSettingsOf({ id: "m", settings_json: "{}" })).toEqual({
    ok: true,
    value: {},
  });
});

test.each(["[]", "nope", "1"])("%s is refused", (text) => {
  expect(modelSettingsOf({ id: "m", settings_json: text })).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});
