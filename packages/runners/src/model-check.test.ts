// The default validateModel: a registered model string, no settings.
import { describe, expect, test } from "vitest";
import { loadAdapter, RUNNER_IDS } from "./adapters/registry.js";
import { MODEL_VALIDATORS } from "./adapters/registry-models.js";
import { acceptRegisteredModels, reservedPortsFrom } from "./model-check.js";
import { checkOperatorModel } from "./models.js";

const ctx = { defaults: {}, registered: ["m-small", "m-large"] };
const row = (model: string, settings: Record<string, unknown> = {}) => ({
  id: "r.x",
  tier: "cheap" as const,
  model,
  settings,
});

test("a registered model string is accepted in any tier; any other is refused", () => {
  expect(acceptRegisteredModels(row("m-large"), ctx).ok).toBe(true);
  const refused = acceptRegisteredModels(row("m-new"), ctx);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error.message).toContain("m-small, m-large");
});

test("settings are refused: such an adapter reads none", () => {
  const refused = acceptRegisteredModels(row("m-small", { url: "x" }), ctx);
  expect(!refused.ok && refused.error.message).toContain("take no settings");
});

test("every adapter's own hook is the one the light registry serves", () => {
  for (const id of RUNNER_IDS) {
    const adapter = loadAdapter(id);
    if (!adapter.ok) throw new Error(adapter.error.message);
    expect(adapter.value.validateModel, id).toBe(MODEL_VALIDATORS.get(id));
  }
});

describe("checkOperatorModel", () => {
  const runner = {
    id: "r",
    defaults_json: "{}",
    registered: ["m-small"],
  };
  const input = {
    id: "r.own",
    runner_id: "r",
    tier: "cheap" as const,
    model: "m-small",
    price_in_per_mtok: 0.2,
    price_out_per_mtok: 0.8,
  };

  test("fills in: cache prices are the input price, effort null, settings {}, active", () => {
    expect(checkOperatorModel(input, runner)).toEqual({
      ok: true,
      value: {
        ...input,
        effort: null,
        price_cache_read_per_mtok: 0.2,
        price_cache_write_per_mtok: 0.2,
        context_tokens: null,
        settings_json: "{}",
        active: true,
      },
    });
    expect(
      checkOperatorModel(
        { ...input, price_cache_read_per_mtok: 0, active: false },
        runner,
      ),
    ).toMatchObject({
      ok: true,
      value: { price_cache_read_per_mtok: 0, active: false },
    });
  });

  test("refuses another runner's row, unparsable defaults, and what the adapter refuses", () => {
    const message = (r: ReturnType<typeof checkOperatorModel>) =>
      r.ok ? "" : r.error.message;
    expect(
      message(checkOperatorModel({ ...input, runner_id: "x" }, runner)),
    ).toContain("names runner x");
    expect(
      message(checkOperatorModel(input, { ...runner, defaults_json: "[" })),
    ).toContain("not a JSON object");
    expect(
      message(checkOperatorModel({ ...input, model: "m-new" }, runner)),
    ).toContain('model r.own (runner r): model "m-new" is not one');
  });
});

test("reservedPortsFrom: the defaults, and the API's and GUI's ports as they read them", () => {
  expect(reservedPortsFrom({})).toEqual([3010, 5173]);
  expect(
    reservedPortsFrom({
      FRM_API_PORT: "4000",
      FRM_WEB_PORT: " 8443 ",
      FRM_API_URL: "http://127.0.0.1:4100",
    }),
  ).toEqual([3010, 5173, 4000, 8443, 4100]);
  expect(
    reservedPortsFrom({ FRM_API_PORT: "nope", FRM_API_URL: "not a url" }),
  ).toEqual([3010, 5173]);
});
