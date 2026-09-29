// The opencode validateModel hook: provider/model for a keyless provider the runner's
// config serves, no effort, and one setting — a provider URL that is http(s), names a host, and
// carries no credentials, query or fragment. Private and loopback hosts are the operator's LAN.
import { describe, expect, test } from "vitest";
import type { ModelContext, ModelProposal } from "../../adapter.js";
import { acceptRegisteredModels } from "../../model-check.js";
import { settingsNoteFor, validateModelFor } from "../../models.js";
import { createOpencodeAdapter } from "./adapter.js";
import {
  blockFor,
  opencodeSettingsNote,
  providerUrlProblem,
  validateOpencodeModel,
} from "./models.js";
import { DEFAULTS, MODELS } from "./registration.js";

const ctx: ModelContext = {
  defaults: { ...DEFAULTS },
  registered: MODELS.map((m) => m.model),
};
const row = (o: Partial<ModelProposal> = {}): ModelProposal => ({
  id: "opencode.local-qwen",
  tier: "standard",
  model: "ollama/qwen3-coder:30b",
  settings: {},
  ...o,
});
const refusal = (r: ModelProposal, c: ModelContext = ctx): string => {
  const v = validateOpencodeModel(r, c);
  if (v.ok) throw new Error("expected a refusal");
  expect(v.error.class).toBe("validation");
  return v.error.message;
};

describe("shape", () => {
  test("a new model of a provider the runner serves is accepted, registered or not", () => {
    expect(validateOpencodeModel(row(), ctx).ok).toBe(true);
    expect(
      validateOpencodeModel(row({ model: MODELS[0]?.model ?? "" }), ctx).ok,
    ).toBe(true);
  });

  test.each(["qwen3", "/qwen", "ollama/", "ollama/has space"])(
    "%s is not provider/model",
    (model) => {
      expect(refusal(row({ model }))).toContain("provider/model");
    },
  );

  test("an effort is refused: opencode has none", () => {
    expect(refusal(row({ effort: "high" }))).toContain("no reasoning effort");
  });

  test("a provider with no block in the runner's providers is refused", () => {
    expect(refusal(row({ model: "openrouter/x" }))).toContain(
      "no provider block",
    );
  });

  test("a keyed provider block is refused, by literal or by {env:} reference", () => {
    for (const options of [
      { apiKey: "{env:SOME_KEY}" },
      { headers: { Authorization: "Bearer x" } },
    ]) {
      const keyed: ModelContext = {
        ...ctx,
        defaults: { providers: { ollama: { options } } },
      };
      expect(refusal(row(), keyed)).toContain(
        "keyed providers are not supported yet",
      );
    }
  });

  test("a runner row whose defaults name no providers serves the shipped ones", () => {
    expect(validateOpencodeModel(row(), { ...ctx, defaults: {} }).ok).toBe(
      true,
    );
    expect(
      refusal(row(), { ...ctx, defaults: { providers: "nope" } }),
    ).toContain("providers are not an object");
  });
});

describe("settings", () => {
  test.each([
    "http://10.0.0.7:11434/v1",
    "https://10.0.0.8/v1",
    "http://127.0.0.1:11434/v1",
    "http://ollama.lan:11434",
  ])("%s is a provider URL", (url) => {
    expect(providerUrlProblem(url)).toBeNull();
    expect(
      validateOpencodeModel(row({ settings: { provider_url: url } }), ctx).ok,
    ).toBe(true);
  });

  test.each<[string, string]>([
    ["10.0.0.7:11434", "not a URL"],
    ["ftp://10.0.0.7/", "http or https"],
    ["file:///etc/passwd", "http or https"],
    ["http://user:pw@10.0.0.7:11434/v1", "credentials"],
    ["http://user@10.0.0.7:11434/v1", "credentials"],
    ["http://10.0.0.7:11434/v1?key=x", "no query"],
    ["http://10.0.0.7:11434/v1#x", "no query"],
    ["not a url", "not a URL"],
  ])("%s is refused (%s)", (url, why) => {
    expect(refusal(row({ settings: { provider_url: url } }))).toContain(why);
  });

  test.each<[string, string]>([
    ["http://169.254.169.254/latest", "link-local"],
    ["http://2852039166/", "link-local"],
    ["http://169.254.0.1:11434/v1", "link-local"],
    ["http://[fe80::1]:11434/v1", "link-local"],
    ["http://[febf::1]:11434/v1", "link-local"],
    ["http://[::ffff:169.254.169.254]/", "link-local"],
    ["http://10.0.0.7:3010/v1", "port 3010"],
    ["http://127.0.0.1:5173/", "port 5173"],
  ])("%s is refused: a metadata host, or Bayon's own port (%s)", (url, why) => {
    expect(refusal(row({ settings: { provider_url: url } }))).toContain(why);
  });

  test("the ports refused are the defaults and the context's: the API's configured port, and a scheme's default", () => {
    const custom: ModelContext = { ...ctx, reservedPorts: [8080, 443] };
    expect(
      refusal(
        row({ settings: { provider_url: "http://10.0.0.7:8080/v1" } }),
        custom,
      ),
    ).toContain("port 8080");
    expect(
      refusal(
        row({ settings: { provider_url: "https://10.0.0.7/v1" } }),
        custom,
      ),
    ).toContain("port 443");
    // The defaults are refused whatever the context adds: a process that cannot see the other's
    // configured port still refuses the usual one.
    expect(
      refusal(
        row({ settings: { provider_url: "http://10.0.0.7:3010/v1" } }),
        custom,
      ),
    ).toContain("port 3010");
    for (const allowed of [
      "http://[::1]:11434/v1",
      "http://[fec0::1]:11434/v1",
      "http://172.16.0.9:11434/v1",
    ])
      expect(providerUrlProblem(allowed), allowed).toBeNull();
  });

  test("any other setting is refused: nothing else is read, and a key has no place here", () => {
    expect(refusal(row({ settings: { api_key: "sk-x" } }))).toContain(
      "api_key",
    );
    expect(refusal(row({ settings: { provider_url: 7 } }))).toContain(
      "provider_url",
    );
  });

  test("blockFor puts the model's URL in place of the runner's, and leaves the rest", () => {
    const block = DEFAULTS.providers.ollama;
    expect(blockFor(block, {})).toBe(block);
    expect(
      blockFor(block, { provider_url: "http://10.0.0.7:11434/v1" }),
    ).toEqual({
      ...block,
      options: { baseURL: "http://10.0.0.7:11434/v1" },
    });
  });
});

test("the adapter's hook, the light entry's and the registry's are one function", () => {
  expect(createOpencodeAdapter().validateModel).toBe(validateOpencodeModel);
  const bad = row({ model: "nope" });
  expect(validateModelFor("opencode", bad, ctx).ok).toBe(false);
  // A runner with no rules of its own takes the default.
  expect(validateModelFor("no-rules", bad, ctx)).toEqual(
    acceptRegisteredModels(bad, ctx),
  );
});

test("the settings note names the port the sandbox opens to any host; nothing when no URL; other runners none", () => {
  expect(
    settingsNoteFor("opencode", { provider_url: "https://10.0.0.7/v1" }),
  ).toBe(
    "this opens port 443 to any host from inside the opencode sandbox (Seatbelt can't restrict by host)",
  );
  expect(opencodeSettingsNote({})).toBeNull();
  expect(
    settingsNoteFor("no-rules", { provider_url: "http://10.0.0.7:1/" }),
  ).toBeNull();
});
