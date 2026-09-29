// The pins' merge rules (the design). The CLI's side, that --settings env outranks a
// repo's own settings files, is shown on the real binary in pinned-env-cli.test.ts.
import { describe, expect, test } from "vitest";
import { DEFAULT_BASE_URL, PINNED_ENV, pinnedEnv } from "./pinned-env.js";

const pins = (env: Record<string, string>): Record<string, string> => {
  const result = pinnedEnv(env);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("pinnedEnv", () => {
  test("with nothing configured, every name gets the value the CLI treats as unset", () => {
    const value = pins({ PATH: "/usr/bin" });
    expect(Object.keys(value).sort()).toEqual(Object.keys(PINNED_ENV).sort());
    expect(value).toMatchObject({
      ANTHROPIC_BASE_URL: DEFAULT_BASE_URL,
      HTTPS_PROXY: "",
      https_proxy: "",
      HTTP_PROXY: "",
      http_proxy: "",
      NODE_EXTRA_CA_CERTS: "",
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
      CLAUDE_CODE_USE_BEDROCK: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_CUSTOM_HEADERS: "",
    });
    // Only the table's names: nothing else of the session env reaches argv.
    expect(value).not.toHaveProperty("PATH");
  });

  test("the default base URL is the first-party API, never empty", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.anthropic.com");
    expect(PINNED_ENV["ANTHROPIC_BASE_URL"]).toBe(DEFAULT_BASE_URL);
  });

  test("a name the session env sets keeps the operator's value, so the repo cannot change it", () => {
    const operator = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
      HTTPS_PROXY: "http://gateway.internal:3128",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    };
    expect(pins(operator)).toMatchObject(operator);
  });

  test("a credential is blanked when the session has none, and never copied when it has one", () => {
    const value = pins({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-never-on-argv",
      ANTHROPIC_CUSTOM_HEADERS: "x-gateway-key: never-on-argv",
    });
    expect(value).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(value).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    expect(value["ANTHROPIC_API_KEY"]).toBe("");
    expect(value["ANTHROPIC_AUTH_TOKEN"]).toBe("");
    expect(JSON.stringify(value)).not.toContain("never-on-argv");
  });

  test("a value with credentials in its URL is refused, naming the variable, never copied", () => {
    for (const proxy of [
      "http://user:secret@proxy.invalid:3128",
      "user:secret@proxy.invalid:3128",
      "https://token@proxy.invalid",
      // Not a URL the parser takes, yet it may still hold a user and password: refused, not copied.
      "http://user:secret@proxy.invalid:bad",
      // A token in the query or the fragment is refused the same way.
      "https://gateway.invalid/?key=secret",
      "https://gateway.invalid/#secret",
    ]) {
      const result = pinnedEnv({ HTTPS_PROXY: proxy });
      expect(result.ok, proxy).toBe(false);
      if (result.ok) continue;
      expect(result.error.class).toBe("validation");
      expect(result.error.message).toContain("HTTPS_PROXY");
      expect(result.error.message).not.toContain("secret");
      expect(result.error.message).not.toContain("token@");
    }
  });

  test("values that are not URLs with credentials pass through: lists, paths, switches", () => {
    const operator = {
      NO_PROXY: "localhost,127.0.0.1,.internal",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      CLAUDE_CODE_USE_BEDROCK: "1",
    };
    expect(pins(operator)).toMatchObject(operator);
  });

  test("the table covers both spellings of every proxy variable", () => {
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]) {
      expect(PINNED_ENV).toHaveProperty(name);
      expect(PINNED_ENV).toHaveProperty(name.toLowerCase());
    }
  });

  test("a proxy the operator sets in one spelling is pinned in both, so no reader sees an empty twin", () => {
    // Bun and Python's urllib prefer the lower-case spelling: an empty one would switch the proxy off.
    expect(
      pins({
        HTTPS_PROXY: "http://gateway.invalid:3128",
        no_proxy: "localhost",
      }),
    ).toMatchObject({
      HTTPS_PROXY: "http://gateway.invalid:3128",
      https_proxy: "http://gateway.invalid:3128",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
      HTTP_PROXY: "",
      http_proxy: "",
    });
    // Both set, differently: each keeps its own.
    expect(
      pins({ HTTP_PROXY: "http://a.invalid", http_proxy: "http://b.invalid" }),
    ).toMatchObject({
      HTTP_PROXY: "http://a.invalid",
      http_proxy: "http://b.invalid",
    });
  });

  test("the runtime's fetch logger is off: it prints every request's headers, the credential among them", () => {
    expect(pins({})["BUN_CONFIG_VERBOSE_FETCH"]).toBe("");
  });
});
