// The session's config, env and permission rules, pure: what opencode is
// told, checked the way opencode reads it (last matching rule wins, no match is `ask`).
import { defaultCommandPolicy } from "@bayon/core";
import { SESSION_GIT_ENV } from "@bayon/executors";
import { describe, expect, test } from "vitest";
import {
  HOME_DIRS,
  ProviderBlock,
  envRefsOf,
  hostEnv,
  ownDirs,
  parseModel,
  sessionConfig,
} from "./home.js";
import { bashRules, permissionConfig } from "./permissions.js";
import { DEFAULTS, OLLAMA_BASE_URL_ENV } from "./registration.js";
import { mcpToolName, mcpWireName } from "./tool-names.js";

const TOKEN = "frm-secret-token-value";
const HOME = "/sessions/s1/home";

type Rules = Readonly<
  Record<string, string | Readonly<Record<string, string>>>
>;

/** opencode's evaluate (permission/index.ts, util/wildcard.ts @ v1.18.32). */
function decide(rules: Rules, permission: string, pattern: string): string {
  const match = (input: string, glob: string): boolean => {
    let escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
    return new RegExp(`^${escaped}$`, "s").test(input);
  };
  const flat = Object.entries(rules).flatMap(([p, v]) =>
    typeof v === "string"
      ? [{ p, pattern: "*", action: v }]
      : Object.entries(v).map(([pattern, action]) => ({ p, pattern, action })),
  );
  return (
    flat.findLast((r) => match(permission, r.p) && match(pattern, r.pattern))
      ?.action ?? "ask"
  );
}

const base = {
  readOnly: false,
  mcpTools: ["conformance_echo", "ticket.read"],
  ownDirs: ownDirs(HOME),
};

describe("permissions", () => {
  test("no policy: every command runs but git push, remote and config", () => {
    const rules = permissionConfig(base);
    expect(decide(rules, "bash", "npm test")).toBe("allow");
    expect(decide(rules, "bash", "git commit -m x")).toBe("allow");
    for (const cmd of [
      "git push",
      "git push origin main",
      "git push-all",
      "git remote add x y",
      "git config user.name x",
    ]) {
      expect(decide(rules, "bash", cmd)).toBe("deny");
    }
  });

  test("a policy allows exactly its prefixes, and still never git push", () => {
    const reviewer = permissionConfig({
      ...base,
      policy: defaultCommandPolicy("reviewer"),
    });
    expect(decide(reviewer, "bash", "git status")).toBe("allow");
    expect(decide(reviewer, "bash", "git diff HEAD~1")).toBe("allow");
    expect(decide(reviewer, "bash", "git commit -m x")).toBe("deny");
    expect(decide(reviewer, "bash", "touch MARKER")).toBe("deny");
    expect(decide(reviewer, "bash", "git statusx")).toBe("deny");
    const builder = permissionConfig({
      ...base,
      policy: defaultCommandPolicy("builder"),
    });
    expect(decide(builder, "bash", "pnpm test")).toBe("allow");
    expect(decide(builder, "bash", "git commit -m x")).toBe("allow");
    expect(decide(builder, "bash", "git push")).toBe("deny");
    expect(decide(builder, "bash", "curl example.com")).toBe("deny");
  });

  test("the always-denied commands come after every allow, whatever the policy", () => {
    for (const policy of [undefined, defaultCommandPolicy("builder")]) {
      const keys = Object.keys(bashRules(policy));
      const push = keys.indexOf("git push*");
      expect(keys.slice(push, push + 3)).toEqual([
        "git push*",
        "git remote*",
        "git config*",
      ]);
      // Nothing after them allows: only the git-smuggling denies follow.
      expect(keys.slice(push + 3).every((k) => k.startsWith("*"))).toBe(true);
    }
  });

  test("git reconfigured around the text denies is denied too (not a boundary: the sandbox is)", () => {
    const rules = permissionConfig(base);
    for (const cmd of [
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=h git commit -m x",
      "export GIT_CONFIG_GLOBAL=/tmp/g",
      "git -c core.hooksPath=./h commit -m x",
      "git --config-env=core.hooksPath=H commit",
      "GIT_DIR=/elsewhere git log",
      "git --git-dir=/mirror.git config x y",
    ]) {
      expect(decide(rules, "bash", cmd)).toBe("deny");
    }
    expect(decide(rules, "bash", "git commit -m 'fix the config parser'")).toBe(
      "allow",
    );
  });

  test("a policy keeps bash offered: its last rule is a prefix, not a blanket deny (fact 7)", () => {
    const rules = bashRules(defaultCommandPolicy("reviewer"));
    expect(Object.keys(rules).at(-1)).not.toBe("*");
  });

  test("no rule falls through to ask: every tool resolves to allow or deny", () => {
    const rules = permissionConfig(base);
    for (const tool of [
      "read",
      "edit",
      "glob",
      "grep",
      "list",
      "bash",
      "task",
      "webfetch",
      "websearch",
      "todowrite",
      "question",
      "doom_loop",
      "skill",
      "external_directory",
      "lsp",
      "foreman_other",
      "some_new_tool",
    ]) {
      expect(["allow", "deny"]).toContain(decide(rules, tool, "/anything"));
    }
  });

  test("subagents, the network and questions are denied; readOnly denies the file tools", () => {
    const rules = permissionConfig(base);
    for (const tool of ["task", "webfetch", "websearch", "question", "skill"]) {
      expect(decide(rules, tool, "*")).toBe("deny");
    }
    expect(decide(rules, "edit", "a.ts")).toBe("allow");
    expect(
      decide(permissionConfig({ ...base, readOnly: true }), "edit", "a.ts"),
    ).toBe("deny");
  });

  test("exactly the session's MCP tools are callable, by opencode's sanitized names", () => {
    const rules = permissionConfig(base);
    expect(decide(rules, "foreman_conformance_echo", "*")).toBe("allow");
    expect(decide(rules, mcpToolName("ticket.read"), "*")).toBe("allow");
    expect(mcpToolName("ticket.read")).toBe("foreman_ticket_read");
    expect(decide(rules, "foreman_ticket_write", "*")).toBe("deny");
    expect(mcpWireName("foreman_conformance_echo")).toBe("conformance_echo");
    expect(mcpWireName("bash")).toBeUndefined();
    expect(mcpWireName("foreman_")).toBeUndefined();
  });

  test("outside the worktree only opencode's own dirs are readable", () => {
    const rules = permissionConfig(base);
    expect(decide(rules, "external_directory", "/etc/*")).toBe("deny");
    expect(
      decide(
        rules,
        "external_directory",
        `${HOME}/xdg/data/opencode/tool-output/x`,
      ),
    ).toBe("allow");
  });
});

describe("session config", () => {
  const block = ProviderBlock.parse(DEFAULTS.providers.ollama);
  const config = sessionConfig({
    ...base,
    model: "ollama/gemma4:26b",
    provider: "ollama",
    modelId: "gemma4:26b",
    block,
  });
  const text = JSON.stringify(config);

  test("the config holds no MCP server at all: the host hands it over ACP, with its bearer", () => {
    expect(config).not.toHaveProperty("mcp");
    expect(text).not.toMatch(/authorization|bearer|FRM_MCP/i);
  });

  test("no compaction, no snapshots, no sharing, no updates, no title call", () => {
    expect(config).toMatchObject({
      compaction: { auto: false, prune: false },
      snapshot: false,
      share: "disabled",
      autoupdate: false,
      agent: { title: { disable: true } },
      enabled_providers: ["ollama"],
    });
  });

  test("the default provider names no address: its base URL comes from the env", () => {
    expect(config["provider"]).toEqual({
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama",
        options: { baseURL: `{env:${OLLAMA_BASE_URL_ENV}}` },
        models: { "gemma4:26b": { name: "gemma4:26b", tool_call: true } },
      },
    });
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:11434/);
  });

  test("a provider block takes no key and no header at all: keyless providers only", () => {
    for (const options of [
      { apiKey: "sk-literal" },
      { apiKey: "{env:OPENAI_API_KEY}" },
      { headers: { "x-key": "{env:KEY}" } },
    ]) {
      const parsed = ProviderBlock.safeParse({ options });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(
        "keyed providers are not supported yet",
      );
    }
    expect(
      ProviderBlock.safeParse({ options: { baseURL: "http://<ollama-host>" } })
        .success,
    ).toBe(false);
  });

  test("models are provider/model", () => {
    expect(parseModel("ollama/qwen3.8:27b")).toEqual({
      ok: true,
      value: { provider: "ollama", id: "qwen3.8:27b" },
    });
    expect(parseModel("openrouter/a/b")).toMatchObject({
      ok: true,
      value: { provider: "openrouter", id: "a/b" },
    });
    for (const bad of ["gemma4", "/x", "ollama/", "a b/c"]) {
      expect(parseModel(bad)).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
    }
  });

  test("the host holds the bearer; opencode may have only the allowlist, never a secret", () => {
    const { env, allow } = hostEnv(
      {
        PATH: "/bin",
        HOME: "/decoy",
        OLLAMA_BASE_URL: "http://<ollama-host>:11434/v1",
        ANTHROPIC_API_KEY: "sk-x",
        FRM_SECRET_OTHER: "y",
      },
      HOME,
      config,
      TOKEN,
      envRefsOf(block),
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: `${HOME}/${HOME_DIRS.home}`,
      TMPDIR: `${HOME}/${HOME_DIRS.tmp}`,
      XDG_CONFIG_HOME: `${HOME}/${HOME_DIRS.config}`,
      XDG_DATA_HOME: `${HOME}/${HOME_DIRS.data}`,
      XDG_CACHE_HOME: `${HOME}/${HOME_DIRS.cache}`,
      XDG_STATE_HOME: `${HOME}/${HOME_DIRS.state}`,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      FRM_MCP_TOKEN: TOKEN,
    });
    expect(allow).toContain("OLLAMA_BASE_URL");
    expect(allow).toContain("OPENCODE_CONFIG_CONTENT");
    for (const secret of [
      "FRM_MCP_TOKEN",
      "ANTHROPIC_API_KEY",
      "FRM_SECRET_OTHER",
    ]) {
      expect(allow).not.toContain(secret);
    }
    const passed = allow.map((n) => env[n] ?? "").join("\n");
    expect(passed).not.toContain(TOKEN);
  });

  test("the model's git reads no system or global config and runs no hook or helper", () => {
    const hostile = { GIT_CONFIG_GLOBAL: "/tmp/g", GIT_CONFIG_COUNT: "0" };
    const { env, allow } = hostEnv(hostile, HOME, config, undefined, []);
    // The shared floor, whatever the session's env held.
    expect(env).toMatchObject(SESSION_GIT_ENV);
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    const count = Number(env["GIT_CONFIG_COUNT"]);
    const settings = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        env[`GIT_CONFIG_KEY_${i}`],
        env[`GIT_CONFIG_VALUE_${i}`],
      ]),
    );
    expect(settings).toMatchObject({
      "core.hooksPath": "/dev/null",
      "credential.helper": "",
      "core.askpass": "",
      "core.fsmonitor": "false",
    });
    for (const name of Object.keys(SESSION_GIT_ENV)) {
      expect(allow).toContain(name);
    }
  });
});
