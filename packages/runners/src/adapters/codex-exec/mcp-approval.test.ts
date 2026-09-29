// 0.154.0 gates every MCP call on approval, and under `approval_policy = never` it denies
// one it would ask about before any request leaves the CLI. The real run's test 11 saw exactly that:
// the model called the tool, the item failed, and nothing reached the probe. The stand-in CLI models
// the gate from the pinned source (stub-codex.mjs, `approvalRefusal`), so these turns run the argv
// turnArgv builds, then the same argv with the one override that fixes it taken out again.
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startMcpProbe } from "../../conformance/mcp-probe.js";
import type { McpProbe } from "../../conformance/types.js";
import { MCP_TOKEN_ENV, turnArgv, type Sandbox } from "./argv.js";
import { CODEX_EXEC_KIT } from "./conformance.js";
import { STUB_CODEX } from "./testing/stub.js";

const APPROVAL = "mcp_servers.foreman.default_tools_approval_mode=";
const DENIED = "MCP tool call requires approval, but approval policy is never";
const NONCE = "n-116";

let probe: McpProbe;
let home: string;

beforeEach(async () => {
  probe = await startMcpProbe();
  home = mkdtempSync(join(tmpdir(), "frm-codex-mcp-"));
});

afterEach(async () => {
  await probe.stop();
  rmSync(home, { recursive: true, force: true });
});

/** The argv of the conformance kit's MCP turn, on the stub, under `sandbox`. */
function argvFor(sandbox: Sandbox): readonly string[] {
  return turnArgv({
    bin: [process.execPath, STUB_CODEX],
    cwd: home,
    model: CHEAP_MODEL,
    sandbox,
    mcp: { url: probe.url, tools: probe.tools, startupTimeoutSec: 20 },
  });
}

/** The argv with the approval override (both its `-c` and its value) removed: the bug, back. */
const withoutApproval = (argv: readonly string[]): readonly string[] =>
  argv.filter(
    (a, i) => !a.startsWith(APPROVAL) && !argv[i + 1]?.startsWith(APPROVAL),
  );

type McpItem = {
  readonly status: string;
  readonly error: { readonly message: string } | null;
};

/** Runs one turn of the kit's MCP prompt; the mcp_tool_call it completed. */
async function mcpTurn(argv: readonly string[]): Promise<McpItem> {
  const [program = "", ...args] = argv;
  const prompt = CODEX_EXEC_KIT.scenario("mcp", {
    nonce: NONCE,
    mcpTool: probe.tools[0] ?? "",
    marker: "m",
    roots: [],
    outside: home,
    rootMarker: "r",
  }).turns[0];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      program,
      args,
      {
        cwd: home,
        env: {
          PATH: process.env["PATH"] ?? "",
          CODEX_HOME: join(home, "codex"),
          [MCP_TOKEN_ENV]: probe.token,
        },
      },
      (error, out) => (error === null ? resolve(out) : reject(error)),
    );
    child.stdin?.end(prompt);
  });
  const completed = stdout
    .split("\n")
    .filter((line) => line !== "")
    .map(
      (line) => JSON.parse(line) as { type: string; item?: { type: string } },
    )
    .filter(
      (e) => e.type === "item.completed" && e.item?.type === "mcp_tool_call",
    )
    .map((e) => e.item as unknown as McpItem);
  expect(completed).toHaveLength(1);
  return completed[0] as McpItem;
}

test("as built, the session's MCP call reaches the server with its bearer and nonce", async () => {
  const item = await mcpTurn(argvFor("workspace-write"));
  expect(item).toMatchObject({ status: "completed", error: null });
  expect(await probe.calls()).toEqual([
    { tool: probe.tools[0], args: { nonce: NONCE }, bearerOk: true },
  ]);
});

test("without the approval override, the call fails inside the CLI and nothing reaches the server: the real run's test 11", async () => {
  for (const sandbox of ["workspace-write", "read-only"] as const) {
    const argv = withoutApproval(argvFor(sandbox));
    expect(argv.join(" ")).not.toContain(APPROVAL);
    const item = await mcpTurn(argv);
    expect(item).toMatchObject({
      status: "failed",
      error: { message: DENIED },
    });
  }
  expect(await probe.calls()).toEqual([]);
});

test("full disk access is 0.154.0's own exemption, which is why a container executor never showed it", async () => {
  const item = await mcpTurn(withoutApproval(argvFor("danger-full-access")));
  expect(item.status).toBe("completed");
  expect(await probe.calls()).toHaveLength(1);
});
