import { describe, expect, test } from "vitest";
import {
  AUTH_FILE,
  AUTH_JSON_ENV,
  CONFIG_FILE,
  CONFIG_TOML,
  authFile,
  configFile,
  schemaFile,
} from "./home.js";

describe("config.toml", () => {
  test("holds housekeeping only: no security key, no secret, no MCP server", () => {
    expect(configFile()).toEqual({
      path: CONFIG_FILE,
      mode: 0o600,
      content: CONFIG_TOML,
    });
    for (const key of [
      "approval_policy",
      "sandbox",
      "shell_environment_policy",
      "mcp_servers",
      "bearer",
      "auth",
    ]) {
      expect(CONFIG_TOML).not.toContain(key);
    }
  });

  test("turns off updates, history, analytics, feedback, memories and subagents", () => {
    const keys = CONFIG_TOML.split("\n").filter(
      (l) => l !== "" && !l.startsWith("#"),
    );
    expect(keys).toEqual([
      "check_for_update_on_startup = false",
      "[history]",
      'persistence = "none"',
      "[analytics]",
      "enabled = false",
      "[feedback]",
      "enabled = false",
      "[memories]",
      "generate_memories = false",
      "use_memories = false",
      "[features]",
      "multi_agent = false",
    ]);
  });
});

describe("auth.json (amendment g)", () => {
  test("no CODEX_AUTH_JSON: nothing to write, the API key is in use", () => {
    expect(authFile({ CODEX_API_KEY: "k" })).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("a JSON object becomes a 0600 file in the private home, verbatim", () => {
    const value = '{"tokens":{"refresh_token":"r"}}';
    expect(authFile({ [AUTH_JSON_ENV]: value })).toEqual({
      ok: true,
      value: { path: AUTH_FILE, mode: 0o600, content: value },
    });
  });

  test.each(["not json", "[1]", "null", '"s"'])(
    "%j is refused, and the error never repeats it",
    (value) => {
      const r = authFile({ [AUTH_JSON_ENV]: value });
      expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
      expect(JSON.stringify(r)).not.toContain(
        value === "null" ? "null," : value,
      );
    },
  );
});

describe("run schema", () => {
  test("SendSpec.output's schema is a 0600 file under out/", () => {
    expect(
      schemaFile("01K00000000000000000000000", { type: "object" }),
    ).toEqual({
      ok: true,
      value: {
        path: "out/01K00000000000000000000000.schema.json",
        mode: 0o600,
        content: '{"type":"object"}',
      },
    });
  });

  test.each(["", "../x", "a/b", "a b"])("run id %j is refused", (runId) => {
    expect(schemaFile(runId, {})).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });
});
