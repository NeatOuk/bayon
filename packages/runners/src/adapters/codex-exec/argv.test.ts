import { SESSION_GIT_ENV } from "@bayon/executors";
import { describe, expect, test } from "vitest";
import {
  GIT_IDENTITY_ENV,
  MCP_TOKEN_ENV,
  SHELL_ENV_ALLOW,
  resolveSandbox,
  securityArgs,
  shellSet,
  turnArgv,
  type TurnArgs,
} from "./argv.js";

const BASE: TurnArgs = {
  bin: ["codex"],
  cwd: "/work/an earlier change",
  model: "gpt-5.6-luna",
  sandbox: "workspace-write",
};

/** The TOML inline table the argv spells `set` as. */
const table = (entries: Readonly<Record<string, string>>): string =>
  `{${Object.entries(entries)
    .map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`)
    .join(",")}}`;

/** The `-c` values of an argv, in order. */
const overrides = (argv: readonly string[]): string[] =>
  argv.flatMap((a, i) => (argv[i - 1] === "-c" ? [a] : []));

describe("turnArgv", () => {
  test("a thread's first turn: exec with -C, JSON, the canary flags, the prompt on stdin", () => {
    const argv = turnArgv({ ...BASE, effort: "low" });
    expect(argv.slice(0, 8)).toEqual([
      "codex",
      "exec",
      "--json",
      "--strict-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.6-luna",
    ]);
    expect(argv.slice(-3)).toEqual(["-C", "/work/an earlier change", "-"]);
    expect(overrides(argv)[0]).toBe('model_reasoning_effort="low"');
    expect(argv).not.toContain("resume");
  });

  test("turn N+1 resumes the thread with no -C (fact 1): its cwd is the process's", () => {
    const argv = turnArgv({
      ...BASE,
      thread: "0199a0b1-0000-7000-8000-000000000001",
    });
    expect(argv.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
    expect(argv).not.toContain("-C");
    expect(argv).not.toContain("--sandbox");
    expect(argv.slice(-2)).toEqual([
      "0199a0b1-0000-7000-8000-000000000001",
      "-",
    ]);
    expect(overrides(argv)).toContain('sandbox_mode="workspace-write"');
  });

  test("a stand-in bin keeps its own arguments ahead of exec", () => {
    expect(
      turnArgv({ ...BASE, bin: ["/usr/bin/node", "/stub.mjs"] }).slice(0, 3),
    ).toEqual(["/usr/bin/node", "/stub.mjs", "exec"]);
  });

  test("SendSpec.output becomes --output-schema and -o, on first and resumed turns", () => {
    const output = {
      schemaPath: "/home/out/run-1.schema.json",
      path: "/tmp/review.json",
    };
    for (const argv of [
      turnArgv({ ...BASE, output }),
      turnArgv({ ...BASE, output, thread: "t-1" }),
    ]) {
      const at = argv.indexOf("--output-schema");
      expect(argv.slice(at, at + 4)).toEqual([
        "--output-schema",
        "/home/out/run-1.schema.json",
        "-o",
        "/tmp/review.json",
      ]);
    }
  });
});

describe("securityArgs", () => {
  test("every turn pins the policy on -c: approvals, sandbox, network, shell env, auth store, search", () => {
    expect(overrides(securityArgs(BASE))).toEqual([
      'approval_policy="never"',
      'sandbox_mode="workspace-write"',
      "sandbox_workspace_write.network_access=false",
      'shell_environment_policy.inherit="core"',
      "shell_environment_policy.ignore_default_excludes=false",
      `shell_environment_policy.include_only=${JSON.stringify(SHELL_ENV_ALLOW)}`,
      `shell_environment_policy.set=${table(SESSION_GIT_ENV)}`,
      'cli_auth_credentials_store="file"',
      'web_search="disabled"',
    ]);
  });

  test("the shell allowlist is 0.154.0's core set, the agents' git identity and the session git floor: no secret is on it", () => {
    expect(SHELL_ENV_ALLOW).toEqual([
      "PATH",
      "SHELL",
      "TMPDIR",
      "TEMP",
      "TMP",
      "HOME",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "LOGNAME",
      "USER",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      // exactly the floor's names, from the shared helper, and nothing else.
      ...Object.keys(SESSION_GIT_ENV),
    ]);
    for (const secret of ["CODEX_API_KEY", "OPENAI_API_KEY", MCP_TOKEN_ENV]) {
      expect(SHELL_ENV_ALLOW).not.toContain(secret);
    }
  });

  test("writable roots ride -c under workspace-write only, right after the network switch", () => {
    const roots = ["/m/worktrees/w", "/m/objects"];
    const on = overrides(securityArgs({ ...BASE, writableRoots: roots }));
    expect(on.slice(2, 4)).toEqual([
      "sandbox_workspace_write.network_access=false",
      `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    ]);
    for (const sandbox of ["read-only", "danger-full-access"] as const) {
      expect(
        overrides(
          securityArgs({ ...BASE, sandbox, writableRoots: roots }),
        ).join(" "),
      ).not.toContain("writable_roots");
    }
    expect(
      overrides(securityArgs({ ...BASE, writableRoots: [] })).join(" "),
    ).not.toContain("writable_roots");
  });

  test("the MCP server rides -c with the bearer's env var name, never its value", () => {
    const args = securityArgs({
      ...BASE,
      mcp: {
        url: "http://127.0.0.1:4000/mcp",
        tools: ["ticket_read", "handoff_write"],
        startupTimeoutSec: 20,
      },
    });
    expect(overrides(args).slice(-6)).toEqual([
      'mcp_servers.foreman.url="http://127.0.0.1:4000/mcp"',
      'mcp_servers.foreman.bearer_token_env_var="FRM_MCP_TOKEN"',
      'mcp_servers.foreman.enabled_tools=["ticket_read","handoff_write"]',
      'mcp_servers.foreman.default_tools_approval_mode="approve"',
      "mcp_servers.foreman.required=true",
      "mcp_servers.foreman.startup_timeout_sec=20",
    ]);
  });

  test("the session's own MCP tools are pre-approved on every sandbox: under approval_policy never, 0.154.0 denies any unannotated tool it would ask about", () => {
    const mcp = {
      url: "http://h/mcp",
      tools: ["ticket_read"],
      startupTimeoutSec: 20,
    };
    for (const sandbox of [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ] as const) {
      expect(overrides(securityArgs({ ...BASE, sandbox, mcp }))).toContain(
        'mcp_servers.foreman.default_tools_approval_mode="approve"',
      );
    }
    // No server, no approval for one: nothing names mcp_servers at all.
    expect(overrides(securityArgs(BASE)).join(" ")).not.toContain(
      "mcp_servers",
    );
  });

  test("strings are escaped as TOML basic strings", () => {
    const [url] = overrides(
      securityArgs({
        ...BASE,
        mcp: { url: 'http://h/"x"\\y', tools: [], startupTimeoutSec: 20 },
      }),
    ).filter((o) => o.startsWith("mcp_servers.foreman.url="));
    expect(url).toBe('mcp_servers.foreman.url="http://h/\\"x\\"\\\\y"');
  });
});

describe("resolveSandbox", () => {
  const BY_KIND = {
    local: "workspace-write",
    container: "danger-full-access",
  } as const;

  test("the default follows the executor's kind (design Q5)", () => {
    expect(resolveSandbox(undefined, BY_KIND, "local")).toEqual({
      ok: true,
      value: "workspace-write",
    });
    expect(resolveSandbox(undefined, BY_KIND, "container")).toEqual({
      ok: true,
      value: "danger-full-access",
    });
    expect(resolveSandbox(undefined, {}, "remote")).toEqual({
      ok: true,
      value: "workspace-write",
    });
  });

  test("a profile may narrow it", () => {
    expect(resolveSandbox("read-only", BY_KIND, "container")).toEqual({
      ok: true,
      value: "read-only",
    });
  });

  test("danger-full-access off a container is refused", () => {
    expect(
      resolveSandbox("danger-full-access", BY_KIND, "local"),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });
});

// git the model runs in its shell gets the session git floor, and the agents' identity.
describe("the model's shell env (shellSet)", () => {
  const IDENTITY = {
    GIT_AUTHOR_NAME: "Bayon Agent",
    GIT_AUTHOR_EMAIL: "agent@bayon.invalid",
    GIT_COMMITTER_NAME: "Bayon Agent",
    GIT_COMMITTER_EMAIL: "agent@bayon.invalid",
  };

  test("the floor from the helper, whatever the session env holds, and the identity from it", () => {
    const set = shellSet({
      ...IDENTITY,
      // A session env that tried to hand the host's config back loses to the floor.
      GIT_CONFIG_GLOBAL: "/home/operator/.gitconfig",
      GIT_CONFIG_COUNT: "0",
    });
    expect(set).toEqual({ ...IDENTITY, ...SESSION_GIT_ENV });
    expect(shellSet({})).toEqual(SESSION_GIT_ENV);
  });

  test("nothing of the session env but the identity is read: no secret reaches argv", () => {
    const set = shellSet({
      ...IDENTITY,
      CODEX_API_KEY: "sk-never",
      OPENAI_API_KEY: "sk-never",
      [MCP_TOKEN_ENV]: "frm-never",
      PATH: "/usr/bin",
    });
    expect(Object.keys(set).toSorted()).toEqual(
      [...GIT_IDENTITY_ENV, ...Object.keys(SESSION_GIT_ENV)].toSorted(),
    );
    const argv = turnArgv({
      ...BASE,
      shellEnv: { ...IDENTITY, CODEX_API_KEY: "sk-never" },
    }).join(" ");
    expect(argv).not.toContain("sk-never");
  });

  test("every name it sets is one include_only keeps, so the allowlist still has the last word", () => {
    for (const name of Object.keys(shellSet(IDENTITY))) {
      expect(SHELL_ENV_ALLOW).toContain(name);
    }
  });

  test("every turn, first and resumed, sets the floor and the identity on -c", () => {
    const want = `shell_environment_policy.set=${table({ ...IDENTITY, ...SESSION_GIT_ENV })}`;
    for (const argv of [
      turnArgv({ ...BASE, shellEnv: IDENTITY }),
      turnArgv({ ...BASE, shellEnv: IDENTITY, thread: "t-1" }),
    ]) {
      expect(overrides(argv)).toContain(want);
    }
  });
});
