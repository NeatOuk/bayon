// the adapter mounts the session's MCP server after the handshake, with a control
// request on the CLI's stdin, so the bearer is on neither argv (where the SDK puts mcpServers,
// an earlier change F1), the CLI's env (its Bash tool inherits that) nor a file; adopt mounts again. An empty
// token is refused, since the CLI would send a bare "Bearer ".
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_POLICY_FLAG, defaultCommandPolicy } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { SessionHandle, SpawnSpec } from "../../adapter.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { mountMcp } from "./mcp-mount.js";
import { ALWAYS_DISALLOWED_TOOLS } from "./permissions.js";
import { DEFAULTS } from "./registration.js";
import { mcpStandIn, type McpStandIn } from "./testing/mcp-stand-in.js";

const STUB = fileURLToPath(new URL("./testing/stub-cli.mjs", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-sdk-mcp-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const local = new LocalExecutor({ id: "local", slots: new SlotCounter(8) });
const adapter = createClaudeSdkAdapter({
  pathToExecutable: STUB,
  executable: "node",
});

const MCP = {
  url: "http://127.0.0.1:1/mcp",
  token: "Zm9yZW1hbi10b2tlbi1mb3ItdGhlLWFkYXB0ZXItdGVzdA",
  tools: ["ticket_get", "human_ask"],
} as const;

/** Real processes run on real time: a deadline, never a sleep. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deadline: ${what}`)),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let n = 0;
function spec(extra: Partial<SpawnSpec> = {}): SpawnSpec {
  const base = join(root, `s${++n}`);
  const cwd = join(base, "work");
  const homeDir = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  return {
    sessionId: `01MCPSESSION${n}`,
    cwd,
    homeDir,
    env: { PATH: process.env["PATH"] ?? "" },
    model: "claude-haiku-4-5",
    flags: { ...DEFAULTS },
    ...extra,
  };
}

async function spawned(s: SpawnSpec): Promise<SessionHandle> {
  const result = await within(adapter.spawn(s, local), "spawn");
  if (!result.ok) throw new Error(`spawn failed: ${result.error.message}`);
  return result.value;
}

const mountOf = (s: SpawnSpec): Record<string, unknown> =>
  JSON.parse(readFileSync(join(s.homeDir, "mcp-set.json"), "utf8")) as Record<
    string,
    unknown
  >;
const argvOf = (s: SpawnSpec): string[] =>
  JSON.parse(readFileSync(join(s.homeDir, "argv.json"), "utf8")) as string[];
const authOf = (s: SpawnSpec): Record<string, string> =>
  JSON.parse(readFileSync(join(s.homeDir, "auth.json"), "utf8")) as Record<
    string,
    string
  >;
const after = (argv: readonly string[], flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// Bayon's /mcp, stood in: it answers MCP.token alone, and a mount that cannot connect fails the start.
let stand: McpStandIn | undefined;
beforeAll(async () => {
  stand = await mcpStandIn(MCP.token, MCP.tools);
});
afterAll(() => stand?.close());
/** Every Authorization /mcp has been sent so far. */
const seenAuth = (): readonly (string | undefined)[] =>
  stand?.authorizations ?? [];
/** The session's mount, on the stand-in. */
const mount = () => ({ ...MCP, url: stand?.url ?? "" });

/** Every file under `dir`, as text. */
const textsUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"));

test("spec.mcp is mounted over the control channel: the bearer reaches /mcp, never argv, env or a file", async () => {
  const s = spec({ mcp: mount() });
  const h = await spawned(s);
  try {
    const argv = argvOf(s);
    expect(argv.join(" ")).not.toContain(MCP.token);
    expect(argv.join(" ")).not.toContain("FRM_MCP_TOKEN");
    expect(argv).not.toContain("--mcp-config");
    expect(argv).toContain("--strict-mcp-config");
    expect(mountOf(s)).toEqual({
      name: "foreman",
      type: "http",
      url: stand?.url,
      alwaysLoad: true,
      authorization: sha256(`Bearer ${MCP.token}`),
    });
    expect(seenAuth()).toContain(`Bearer ${MCP.token}`);
    expect(after(argv, "--allowedTools")?.split(",")).toEqual([
      "mcp__foreman__ticket_get",
      "mcp__foreman__human_ask",
    ]);
    expect(authOf(s)).not.toHaveProperty("FRM_MCP_TOKEN");
    // Nothing in the home the model's shell can read holds it (the stub's own records aside,
    // which hold it as a digest).
    expect(textsUnder(s.homeDir).join("\n")).not.toContain(MCP.token);
  } finally {
    await adapter.stop(h, "kill");
  }
});

test("adopt mounts the server again on the resumed process", async () => {
  const s = spec({ mcp: mount() });
  const first = await spawned(s);
  await adapter.stop(first, "kill");
  rmSync(join(s.homeDir, "mcp-set.json"));
  const before = seenAuth().length;
  const adopted = await within(
    adapter.adopt(
      { ...s, resumeRunnerSessionId: first.runnerSessionId ?? "" },
      local,
    ),
    "adopt",
  );
  if (!adopted.ok) throw new Error(`adopt failed: ${adopted.error.message}`);
  try {
    expect(argvOf(s).join(" ")).toContain(`--resume`);
    expect(argvOf(s).join(" ")).toContain(first.runnerSessionId ?? "?");
    expect(mountOf(s)).toMatchObject({
      authorization: sha256(`Bearer ${MCP.token}`),
    });
    expect(seenAuth().slice(before)).toContain(`Bearer ${MCP.token}`);
    expect(authOf(s)).not.toHaveProperty("FRM_MCP_TOKEN");
  } finally {
    await adapter.stop(adopted.value, "kill");
  }
});

test("a CLI that refuses the mount fails the start, and the token is not in the error", async () => {
  const error = await mountMcp(
    {
      setMcpServers: () =>
        Promise.reject(new Error(`bad header Bearer ${MCP.token}`)),
    },
    spec({ mcp: MCP }),
  );
  expect(error).toMatchObject({ class: "spawn_failed" });
  expect(error?.message).not.toContain(MCP.token);
  expect(error?.message).toContain("[redacted]");
});

test("without spec.mcp nothing is mounted and no token is in the env", async () => {
  const s = spec();
  const h = await spawned(s);
  try {
    expect(argvOf(s)).not.toContain("--mcp-config");
    expect(() => mountOf(s)).toThrow(); // no mcp_set_servers request at all
    expect(authOf(s)).not.toHaveProperty("FRM_MCP_TOKEN");
  } finally {
    await adapter.stop(h, "kill");
  }
});

test("a server the CLI could not connect fails the mount, retryably, and the token is not in the error", async () => {
  const error = await mountMcp(
    {
      setMcpServers: () =>
        Promise.resolve({
          added: [],
          removed: [],
          errors: { foreman: `HTTP 401 for Bearer ${MCP.token}` },
        }),
    },
    spec({ mcp: MCP }),
  );
  expect(error).toMatchObject({ class: "spawn_failed", retryable: true });
  expect(error?.message).not.toContain(MCP.token);
  expect(error?.message).toContain("[redacted]");
  // Another server's error is not this session's.
  expect(
    await mountMcp(
      {
        setMcpServers: () =>
          Promise.resolve({ added: [], removed: [], errors: { other: "x" } }),
      },
      spec({ mcp: MCP }),
    ),
  ).toBeUndefined();
});

test("a /mcp that refuses the bearer fails the spawn: spawn_failed, retryable", async () => {
  const s = spec({ mcp: { ...mount(), token: "not-the-session-token" } });
  const result = await within(adapter.spawn(s, local), "spawn");
  expect(result).toMatchObject({
    ok: false,
    error: { class: "spawn_failed", retryable: true },
  });
  if (!result.ok) {
    expect(result.error.message).not.toContain("not-the-session-token");
  }
});

test("an empty token refuses the spawn: the CLI would send a bare bearer", async () => {
  const result = await within(
    adapter.spawn(spec({ mcp: { ...MCP, token: "" } }), local),
    "spawn",
  );
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("the profile's own allowedTools are kept, and its disallowedTools still win", async () => {
  const s = spec({
    mcp: mount(),
    flags: {
      ...DEFAULTS,
      allowedTools: ["Read"],
      disallowedTools: ["mcp__foreman__human_ask"],
    },
  });
  const h = await spawned(s);
  try {
    const argv = argvOf(s);
    expect(after(argv, "--allowedTools")?.split(",")).toEqual([
      "Read",
      "mcp__foreman__ticket_get",
    ]);
    expect(after(argv, "--disallowedTools")?.split(",")).toEqual([
      "mcp__foreman__human_ask",
      ...ALWAYS_DISALLOWED_TOOLS,
    ]);
  } finally {
    await adapter.stop(h, "kill");
  }
});

test("a role's command policy becomes Bash rules; push, remote and config stay denied even when allowed", async () => {
  const s = spec({
    mcp: mount(),
    flags: {
      ...DEFAULTS,
      allowedTools: ["Bash(git push:*)"],
      [COMMAND_POLICY_FLAG]: defaultCommandPolicy("builder"),
    },
  });
  const h = await spawned(s);
  try {
    const argv = argvOf(s);
    const allowed = after(argv, "--allowedTools")?.split(",") ?? [];
    for (const rule of [
      "Bash(git status:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git fetch:*)",
      "Bash(git merge:*)",
      "Bash(git rebase:*)",
      "Bash(pnpm:*)",
      "Bash(node:*)",
      "Bash(mkdir:*)",
    ]) {
      expect(allowed).toContain(rule);
    }
    expect(allowed).not.toContain("Bash(git push:*)");
    expect(allowed.slice(-2)).toEqual([
      "mcp__foreman__ticket_get",
      "mcp__foreman__human_ask",
    ]);
    expect(after(argv, "--disallowedTools")?.split(",")).toEqual([
      // the subagent tool is withheld by default, so it leads the denials.
      ...DEFAULTS.disallowedTools,
      "Bash(git push:*)",
      "Bash(git remote:*)",
      "Bash(git config:*)",
    ]);
  } finally {
    await adapter.stop(h, "kill");
  }
});

test("a reviewer's policy approves read-only git only; commit stays unapproved and the three denied", async () => {
  const s = spec({
    flags: {
      ...DEFAULTS,
      [COMMAND_POLICY_FLAG]: defaultCommandPolicy("reviewer"),
    },
  });
  const h = await spawned(s);
  try {
    const argv = argvOf(s);
    const allowed = after(argv, "--allowedTools")?.split(",") ?? [];
    expect(allowed.filter((rule) => rule.startsWith("Bash("))).toEqual([
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git ls-files:*)",
      "Bash(git grep:*)",
    ]);
    expect(allowed).not.toContain("Bash(git commit:*)");
    expect(after(argv, "--disallowedTools")?.split(",")).toEqual([
      // the subagent tool is withheld by default, so it leads the denials.
      ...DEFAULTS.disallowedTools,
      ...ALWAYS_DISALLOWED_TOOLS,
    ]);
  } finally {
    await adapter.stop(h, "kill");
  }
});

test("with no policy and no profile allowlist, no Bash rule is approved and the three are still denied", async () => {
  const s = spec();
  const h = await spawned(s);
  try {
    const argv = argvOf(s);
    expect(argv.join(" ")).not.toContain("Bash(git commit");
    expect(after(argv, "--disallowedTools")?.split(",")).toEqual([
      // the subagent tool is withheld by default, so it leads the denials.
      ...DEFAULTS.disallowedTools,
      ...ALWAYS_DISALLOWED_TOOLS,
    ]);
  } finally {
    await adapter.stop(h, "kill");
  }
});

test("a malformed command policy refuses the spawn rather than drop the denials", async () => {
  const result = await within(
    adapter.spawn(
      spec({
        flags: { ...DEFAULTS, [COMMAND_POLICY_FLAG]: { groups: ["git_push"] } },
      }),
      local,
    ),
    "spawn",
  );
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("a stored mcpTokenVia is ignored: no file, no env, the same mount", async () => {
  const s = spec({
    mcp: mount(),
    flags: { ...DEFAULTS, mcpTokenVia: "file" },
  });
  const h = await spawned(s);
  try {
    expect(argvOf(s)).not.toContain("--mcp-config");
    expect(readdirSync(s.homeDir)).not.toContain("mcp.json");
    expect(authOf(s)).not.toHaveProperty("FRM_MCP_TOKEN");
    expect(mountOf(s)).toMatchObject({
      authorization: sha256(`Bearer ${MCP.token}`),
    });
  } finally {
    await adapter.stop(h, "kill");
  }
});
