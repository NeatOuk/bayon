// A file where the home is. The stand-in executor runs on this host but is a container
// to the adapter (kind container), as home-remote.test.ts's is: the file goes through one fixed
// program with the content on stdin, never argv; it is 0600. The MCP bearer no longer has one: it
// is mounted over the CLI's stdin.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalExecutor,
  SlotCounter,
  type Argv,
  type Executor,
} from "@bayon/executors";
import { afterAll, expect, test } from "vitest";
import type { SpawnSpec } from "../../adapter.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { writeHomeFile } from "./home-file.js";
import { DEFAULTS } from "./registration.js";
import { mcpStandIn } from "./testing/mcp-stand-in.js";

const STUB = fileURLToPath(new URL("./testing/stub-cli.mjs", import.meta.url));
const SECRET = "bWNwLWZpbGUtdG9rZW4tbmV2ZXItb24tYXJndg";
const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-sdk-homefile-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const local = new LocalExecutor({ id: "local", slots: new SlotCounter(4) });

/** A container to the adapter, running on this host; it records every argv it is handed. */
function standIn(): { readonly ex: Executor; readonly argv: Argv[] } {
  const argv: Argv[] = [];
  const ex: Executor = {
    id: "ctr-stand-in",
    kind: "container",
    capabilities: { pty: false },
    envPath: process.env["PATH"] ?? "/usr/bin:/bin",
    prepare: (spec) => local.prepare(spec),
    exec: (a, opts) => {
      argv.push(a);
      return local.exec(a, opts);
    },
    pty: (a, opts) => local.pty(a, opts),
    probe: (ref) => local.probe(ref),
    cleanup: (ref, mode) => local.cleanup(ref, mode),
    capacity: () => local.capacity(),
    health: (limits) => local.health(limits),
  };
  return { ex, argv };
}

let n = 0;
const home = (): string => {
  const dir = join(base, `h${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};
const mode = (path: string): number => statSync(path).mode & 0o777;

test("through the executor: one fixed program writes it 0600 from stdin, the content on no argv", async () => {
  const { ex, argv } = standIn();
  const path = join(home(), "mcp.json");
  const content = JSON.stringify({ token: SECRET });
  expect(await writeHomeFile(ex, path, content)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(readFileSync(path, "utf8")).toBe(content);
  expect(mode(path)).toBe(0o600);
  // A file that was there keeps no looser mode.
  chmodSync(path, 0o644);
  expect((await writeHomeFile(ex, path, `${content}\n`)).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(`${content}\n`);
  expect(mode(path)).toBe(0o600);
  expect(argv[0]?.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
  expect(argv.flat().join("\n").includes(SECRET)).toBe(false);
});

test("a write that cannot land is spawn_failed and names the file", async () => {
  const { ex } = standIn();
  const path = join(base, "no-such-dir", "mcp.json");
  expect(await writeHomeFile(ex, path, "x")).toMatchObject({
    ok: false,
    error: { class: "spawn_failed", message: expect.stringContaining(path) },
  });
});

test("on a local executor it is this host's disk, as before", async () => {
  const path = join(home(), "mcp.json");
  expect((await writeHomeFile(local, path, SECRET)).ok).toBe(true);
  expect(mode(path)).toBe(0o600);
});

/** A session with an MCP mount and a stored mcpTokenVia "file", its dirs made. */
function mountSpec(url: string): SpawnSpec {
  const dir = join(base, `s${++n}`);
  const s: SpawnSpec = {
    sessionId: `01HOMEFILE${n}`,
    cwd: join(dir, "work"),
    homeDir: join(dir, "home"),
    env: { PATH: process.env["PATH"] ?? "" },
    model: "claude-haiku-4-5",
    flags: { ...DEFAULTS, mcpTokenVia: "file" },
    mcp: {
      url,
      token: SECRET,
      tools: ["ticket_get"],
    },
  };
  mkdirSync(s.cwd, { recursive: true });
  mkdirSync(s.homeDir, { recursive: true, mode: 0o700 });
  return s;
}

test("on a container the MCP mount writes no file: the token on no argv, in no home file", async () => {
  const { ex, argv } = standIn();
  const mcp = await mcpStandIn(SECRET, ["ticket_get"]);
  const s = mountSpec(mcp.url);
  const adapter = createClaudeSdkAdapter({
    pathToExecutable: STUB,
    executable: "node",
  });
  const spawned = await adapter.spawn(s, ex);
  if (!spawned.ok) throw new Error(spawned.error.message);
  try {
    expect(existsSync(join(s.homeDir, "mcp.json"))).toBe(false);
    expect(argv.flat().join("\n").includes(SECRET)).toBe(false);
    expect(argv.flat()).not.toContain("--mcp-config");
    // Only the stub's own mcp-set.json records the mount, and as a digest.
    expect(readFileSync(join(s.homeDir, "mcp-set.json"), "utf8")).not.toContain(
      SECRET,
    );
  } finally {
    await adapter.stop(spawned.value, "kill");
    await mcp.close();
  }
});
