// The env a proxied claude-sdk session starts with: tool search as the proxy's upstream
// would have it, the operator's choice kept, and unproxied sessions exactly as before. The CLI's side
// (that the flag brings tool search back through the proxy) is shown on the real binary in
// tool-search-cli.test.ts.
import { describe, expect, test } from "vitest";
import type { SpawnSpec } from "../../adapter.js";
import { PROXY_HEADER } from "../../model-proxy.js";
import { pinnedEnv } from "./pinned-env.js";
import {
  TOOL_SEARCH_ENV,
  inlineEnv,
  sessionEnv,
  toolSearchEnv,
  type ProfileEnv,
} from "./session-env.js";

const PROXY = { url: "http://127.0.0.1:40111", token: "b".repeat(64) };

const spec = (env: Record<string, string> = {}): SpawnSpec => ({
  sessionId: "01SESSIONENV",
  cwd: "/work",
  homeDir: "/home",
  env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test-dummy", ...env },
  model: "m",
  flags: {},
});

const inline = (
  s: SpawnSpec,
  profileEnv: ProfileEnv,
  proxy = PROXY,
): Readonly<Record<string, unknown>> => {
  const r = inlineEnv(s, profileEnv, proxy);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("tool search while proxied", () => {
  test.each([
    ["no base URL (the CLI's default)", {}],
    [
      "the first-party API",
      { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
    ],
    [
      "the first-party API with a path and its default port",
      { ANTHROPIC_BASE_URL: "https://api.anthropic.com:443/v1/" },
    ],
  ])("upstream %s: on, in the child env and pinned inline", (_, env) => {
    const s = spec(env);
    const child = sessionEnv(s, undefined, PROXY);
    expect(child[TOOL_SEARCH_ENV]).toBe("true");
    expect(child["ANTHROPIC_BASE_URL"]).toBe(PROXY.url);
    expect(child["ANTHROPIC_CUSTOM_HEADERS"]).toBe(
      `${PROXY_HEADER}: ${PROXY.token}`,
    );
    const settings = inline(s, undefined);
    expect(settings[TOOL_SEARCH_ENV]).toBe("true");
    expect(settings["ANTHROPIC_BASE_URL"]).toBe(PROXY.url);
    // The bearer stays off argv, as before.
    expect(JSON.stringify(settings)).not.toContain(PROXY.token);
  });

  test.each([
    ["a gateway", { ANTHROPIC_BASE_URL: "https://gateway.example/anthropic" }],
    ["a local server", { ANTHROPIC_BASE_URL: "http://127.0.0.1:8080" }],
    [
      "the first-party host on another port",
      { ANTHROPIC_BASE_URL: "https://api.anthropic.com:8443" },
    ],
  ])(
    "upstream %s: nothing, since the CLI keeps it off there without the proxy too",
    (_, env) => {
      const s = spec(env);
      expect(toolSearchEnv(s, undefined)).toEqual({});
      expect(sessionEnv(s, undefined, PROXY)).not.toHaveProperty(
        TOOL_SEARCH_ENV,
      );
      expect(inline(s, undefined)).not.toHaveProperty(TOOL_SEARCH_ENV);
    },
  );

  test("the profile's inline base URL is the upstream, as it is for the CLI", () => {
    const s = spec({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
    const gateway = { ANTHROPIC_BASE_URL: "https://gateway.example" };
    expect(toolSearchEnv(s, gateway)).toEqual({});
    expect(toolSearchEnv(spec(), { ANTHROPIC_BASE_URL: "" })).toEqual({
      [TOOL_SEARCH_ENV]: "true",
    });
    // The proxy's base URL still wins over the profile's, inline.
    expect(inline(s, gateway)["ANTHROPIC_BASE_URL"]).toBe(PROXY.url);
  });

  test("an operator's own value stands, from the session env or the profile's inline env", () => {
    for (const value of ["false", "auto:10", "true"]) {
      const s = spec({ [TOOL_SEARCH_ENV]: value });
      expect(toolSearchEnv(s, undefined)).toEqual({});
      expect(sessionEnv(s, undefined, PROXY)[TOOL_SEARCH_ENV]).toBe(value);
      // Not a pin: the child env carries it, and the inline settings add nothing of ours.
      expect(inline(s, undefined)).not.toHaveProperty(TOOL_SEARCH_ENV);
    }
    const profile = { [TOOL_SEARCH_ENV]: "false" };
    expect(sessionEnv(spec(), profile, PROXY)).not.toHaveProperty(
      TOOL_SEARCH_ENV,
    );
    expect(inline(spec(), profile)[TOOL_SEARCH_ENV]).toBe("false");
  });

  test('"" counts as unset, as the CLI counts it', () => {
    const s = spec({ [TOOL_SEARCH_ENV]: "" });
    expect(sessionEnv(s, undefined, PROXY)[TOOL_SEARCH_ENV]).toBe("true");
    expect(inline(s, { [TOOL_SEARCH_ENV]: "" })[TOOL_SEARCH_ENV]).toBe("true");
    expect(inline(s, undefined)[TOOL_SEARCH_ENV]).toBe("true");
  });
});

describe("unproxied: as before", () => {
  test("the child env is the session env, and the inline env the pins and the profile's", () => {
    const s = spec();
    expect(sessionEnv(s, undefined, undefined)).toBe(s.env);
    const pins = pinnedEnv(s.env);
    const r = inlineEnv(s, { X_PROFILE: "1" });
    expect(r.ok && r.value).toEqual({
      ...(pins.ok ? pins.value : {}),
      X_PROFILE: "1",
    });
    expect(r.ok && r.value).not.toHaveProperty(TOOL_SEARCH_ENV);
  });
});
