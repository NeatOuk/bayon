// The claude-sdk validateModel hook: a model string shaped like the CLI's own, or one
// this adapter already registers; a required context_tokens within the CLI's window rule for the
// string's [1m] opt-in; a valid effort or none; and no settings, since this adapter reads none.
import { describe, expect, test } from "vitest";
import type { ModelContext, ModelProposal } from "../../adapter.js";
import { validateModelFor } from "../../models.js";
import { MODELS } from "./registration.js";
import {
  MODEL_PATTERN,
  requiredCliVersion,
  validateClaudeSdkModel,
} from "./models.js";
import { DEFAULT_WINDOW, ONE_M_WINDOW } from "./window.js";

const ctx: ModelContext = {
  defaults: {},
  registered: MODELS.map((m) => m.model),
};
const row = (o: Partial<ModelProposal> = {}): ModelProposal => ({
  id: "claude-sdk.new",
  tier: "standard",
  model: "claude-opus-6",
  settings: {},
  contextTokens: DEFAULT_WINDOW,
  ...o,
});
const withoutContextTokens = (
  o: Partial<ModelProposal> = {},
): ModelProposal => ({
  id: "claude-sdk.new",
  tier: "standard",
  model: "claude-opus-6",
  settings: {},
  ...o,
});
const refusal = (r: ModelProposal, c: ModelContext = ctx): string => {
  const v = validateClaudeSdkModel(r, c);
  if (v.ok) throw new Error("expected a refusal");
  expect(v.error.class).toBe("validation");
  return v.error.message;
};

describe("model string shape", () => {
  test("MODEL_PATTERN accepts claude-shaped strings, with or without [1m]", () => {
    expect(MODEL_PATTERN.test("claude-opus-6")).toBe(true);
    expect(MODEL_PATTERN.test("claude-sonnet-5-1[1m]")).toBe(true);
    for (const m of MODELS) expect(MODEL_PATTERN.test(m.model)).toBe(true);
  });

  test("MODEL_PATTERN refuses everything else", () => {
    for (const bad of [
      "Claude-opus-6",
      "claude-",
      "claude--x",
      "claude-x[1M]",
      "claude-x[1m]x",
      "gpt-5",
      "claude-x/y",
    ]) {
      expect(MODEL_PATTERN.test(bad)).toBe(false);
    }
  });

  test("accepts a new claude-shaped string and every shipped one", () => {
    expect(validateClaudeSdkModel(row(), ctx).ok).toBe(true);
    expect(
      validateClaudeSdkModel(
        row({ model: "claude-sonnet-5-1[1m]", contextTokens: ONE_M_WINDOW }),
        ctx,
      ).ok,
    ).toBe(true);
  });

  test("every registered row passes its own hook (registration <-> hook agreement)", () => {
    for (const m of MODELS) {
      const verdict = validateClaudeSdkModel(
        {
          id: m.id,
          tier: m.tier,
          model: m.model,
          ...(m.effort === undefined ? {} : { effort: m.effort }),
          settings: {},
          contextTokens: m.contextTokens,
        },
        ctx,
      );
      expect(verdict.ok).toBe(true);
    }
  });

  test("refuses a string off the pattern that is not already registered", () => {
    expect(refusal(row({ model: "gpt-5" }))).toMatch(MODEL_PATTERN.source);
  });
});

describe("window", () => {
  test("[1m]: 1,000,000 ok, 1,000,001 refused", () => {
    expect(
      validateClaudeSdkModel(
        row({ model: "claude-x[1m]", contextTokens: ONE_M_WINDOW }),
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      refusal(row({ model: "claude-x[1m]", contextTokens: ONE_M_WINDOW + 1 })),
    ).toMatch(String(ONE_M_WINDOW));
  });

  test("unsuffixed: 200,000 ok, 200,001 refused", () => {
    expect(
      validateClaudeSdkModel(row({ contextTokens: DEFAULT_WINDOW }), ctx).ok,
    ).toBe(true);
    expect(refusal(row({ contextTokens: DEFAULT_WINDOW + 1 }))).toMatch(
      String(DEFAULT_WINDOW),
    );
  });

  test("missing context_tokens is refused", () => {
    expect(refusal(withoutContextTokens())).toMatch("context_tokens");
  });
});

describe("effort", () => {
  test("xhigh is accepted, turbo is refused", () => {
    expect(validateClaudeSdkModel(row({ effort: "xhigh" }), ctx).ok).toBe(true);
    expect(refusal(row({ effort: "turbo" }))).toMatch("effort");
  });
});

describe("settings", () => {
  test("any setting is refused: this adapter reads none from a models row", () => {
    expect(refusal(row({ settings: { provider_url: "http://x" } }))).toMatch(
      "no settings",
    );
  });
});

describe("validateModelFor wiring", () => {
  test("the registry routes claude-sdk to this hook", () => {
    expect(validateModelFor("claude-sdk", row(), ctx).ok).toBe(true);
  });
});

describe("requiredCliVersion", () => {
  test("reads the CLI's version refusal", () => {
    expect(
      requiredCliVersion(
        "Claude Code 2.1.283 does not support this model; version 2.2.0 or newer is required",
      ),
    ).toBe(
      "claude CLI 2.1.283 cannot run this model: version 2.2.0 or newer is required (update the pinned SDK/CLI)",
    );
  });

  test("null on an unrelated 400", () => {
    expect(requiredCliVersion("invalid_request_error: bad request")).toBeNull();
  });
});
