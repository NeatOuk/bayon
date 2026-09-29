// a start whose MCP mount fails, through the adapter, with the real SDK, the stub CLI and
// the real local executor. The CLI refuses the mount with an error quoting the bearer, or never
// answers it before the init timeout. Either way the start is spawn_failed, the bearer is not in the
// error, the process is killed and the session's context proxy is closed.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_RULESET, CONTEXT_STORE_DIR, type Clock } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { SpawnSpec } from "../../adapter.js";
import { startFakeUpstream, type FakeUpstream } from "../../fake-upstream.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { DEFAULTS } from "./registration.js";
import { mcpStandIn, type McpStandIn } from "./testing/mcp-stand-in.js";

const STUB = fileURLToPath(new URL("./testing/stub-cli.mjs", import.meta.url));
const BEARER = "frm-fake-mcp-bearer-for-the-mount-failure-test";
const WAIT = { timeout: 10_000, interval: 50 };
const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-sdk-mountfail-")));
const local = new LocalExecutor({ id: "local", slots: new SlotCounter(4) });

let upstream: FakeUpstream;
let mcp: McpStandIn;
beforeAll(async () => {
  upstream = await startFakeUpstream();
  mcp = await mcpStandIn(BEARER, ["ticket_get"]);
});
afterAll(async () => {
  await upstream.close();
  await mcp.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
/** A session behind the context proxy, whose stub CLI answers the mount as `mode` says. */
function spec(mode: "error" | "hang"): SpawnSpec {
  const base = join(root, `s${++n}`);
  const cwd = join(base, "work");
  const homeDir = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return {
    sessionId: `01MOUNTFAIL${n}`,
    cwd,
    homeDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      ANTHROPIC_BASE_URL: upstream.url,
      FRM_STUB_MCP_SET: mode,
    },
    model: "claude-haiku-4-5",
    flags: { ...DEFAULTS },
    mcp: { url: mcp.url, token: BEARER, tools: ["ticket_get"] },
    contextCompression: {
      ruleset: CONTEXT_RULESET,
      storeDir: join(base, CONTEXT_STORE_DIR),
      token: randomBytes(32).toString("hex"),
    },
  };
}

/** The proxy's port, from the base URL pinned in the CLI's inline settings. */
function proxyPortOf(s: SpawnSpec): number {
  const argv = JSON.parse(
    readFileSync(join(s.homeDir, "argv.json"), "utf8"),
  ) as string[];
  const inline = JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}") as {
    env?: Record<string, unknown>;
  };
  return Number(new URL(String(inline.env?.["ANTHROPIC_BASE_URL"])).port);
}

/** Whether anything listens on 127.0.0.1:`port` (a refused connection is no). */
const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/", method: "GET" },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.end();
  });

/** Whether the stub CLI of `s` still runs. */
function alive(s: SpawnSpec): boolean {
  const pid = JSON.parse(
    readFileSync(join(s.homeDir, "pid.json"), "utf8"),
  ) as number;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A failed start: its error redacted, its process gone, its proxy closed. */
async function expectCleanFailure(
  s: SpawnSpec,
  started: Awaited<
    ReturnType<ReturnType<typeof createClaudeSdkAdapter>["spawn"]>
  >,
  message: string,
): Promise<void> {
  expect(started).toMatchObject({
    ok: false,
    error: { class: "spawn_failed", message: expect.stringContaining(message) },
  });
  expect(JSON.stringify(started)).not.toContain(BEARER);
  // The mount was asked for: the failure is the mount's, not an earlier step's.
  expect(existsSync(join(s.homeDir, "mcp-set.json"))).toBe(true);
  await vi.waitFor(() => expect(alive(s)).toBe(false), WAIT);
  expect(await listening(proxyPortOf(s))).toBe(false);
}

test("a CLI that refuses the mount, quoting the bearer: spawn_failed, redacted, killed, proxy closed", async () => {
  const adapter = createClaudeSdkAdapter({
    pathToExecutable: STUB,
    executable: "node",
  });
  const s = spec("error");
  const started = await adapter.spawn(s, local);
  await expectCleanFailure(s, started, "the runner refused the MCP mount");
  if (!started.ok) expect(started.error.message).toContain("[redacted]");
});

test("the init timeout firing during the mount: spawn_failed, killed, proxy closed", async () => {
  // A clock whose timeout fires only once the CLI holds the mount request, unanswered.
  const s = spec("hang");
  const clock: Clock = {
    now: () => 0,
    after: async () => {
      await vi.waitFor(
        () => expect(existsSync(join(s.homeDir, "mcp-set.json"))).toBe(true),
        WAIT,
      );
    },
  };
  const adapter = createClaudeSdkAdapter({
    pathToExecutable: STUB,
    executable: "node",
    clock,
  });
  const started = await adapter.spawn(s, local);
  await expectCleanFailure(
    s,
    started,
    "no runner handshake and MCP mount within",
  );
});
