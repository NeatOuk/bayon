// Where the CLI starts. In a session an executor places (a container's), the image's CLI
// by its path in the image, with the session's paths and env. Everywhere else, the SDK's bundled
// binary, as before; a stand-in wherever one is given. The credential and the MCP token ride the
// child's env only, never argv (Invariant 11). The recorders run nothing: the SDK then fails its
// handshake at once, and the argv it asked for is the evidence.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Argv, ExecOpts, Proc, SessionPlace } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { describe, expect, test } from "vitest";
import type { SpawnSpec } from "../../adapter.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { CLAUDE_IMAGE_CLI } from "./container.js";
import { DEFAULTS } from "./registration.js";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const SDK_DIR = dirname(createRequire(import.meta.url).resolve(SDK_PACKAGE));
const IMAGE_PATH = "/usr/local/bin:/usr/bin:/bin";
const TOKEN = "sk-ant-oat01-sentinel-never-on-argv-0123456789";
const MCP_TOKEN = "mcp-sentinel-never-on-argv-0123456789";

/** This platform's bundled binary, as the SDK resolves it; undefined where none is installed. */
function bundledBinary(): string | undefined {
  try {
    const sdk = createRequire(import.meta.url).resolve(SDK_PACKAGE);
    const pkg = createRequire(sdk).resolve(
      `${SDK_PACKAGE}-${process.platform}-${process.arch}/package.json`,
    );
    const binary = join(dirname(pkg), "claude");
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

type Seen = { readonly argv: Argv; readonly opts: ExecOpts };

/** Records each exec and runs nothing, like this host (no placement). */
class Recorder extends FakeExecutor {
  readonly seen: Seen[] = [];
  constructor() {
    super({ programs: {} });
  }
  override exec(argv: Argv, opts: ExecOpts): Promise<Proc> {
    this.seen.push({ argv, opts });
    return Promise.reject(new Error("a recorder runs nothing"));
  }
}

/** Places sessions as a container executor does (container.ts), with the image's PATH. */
class Placing extends Recorder {
  readonly envPath = IMAGE_PATH;
  placeSession(sessionId: string): SessionPlace {
    const root = `/frm/s/${sessionId}`;
    return { root, home: `${root}/.frm/home`, tmp: `${root}/.frm/tmp` };
  }
}

const SID = "01PLACED";
const ROOT = `/frm/s/${SID}`;
/** A placed session's spec: every path the container's, the credential resolved into env. */
const placed = (): SpawnSpec => ({
  sessionId: SID,
  cwd: `${ROOT}/repo`,
  homeDir: `${ROOT}/.frm/home`,
  env: {
    PATH: IMAGE_PATH,
    HOME: `${ROOT}/.frm/home`,
    TMPDIR: `${ROOT}/.frm/tmp`,
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
  },
  model: "claude-haiku-4-5",
  flags: { ...DEFAULTS },
  mcp: {
    url: "http://10.9.0.2:7070/mcp",
    token: MCP_TOKEN,
    tools: ["ticket_get"],
  },
});

/** Every host path a container could never hold. */
const HOST_PATHS = [process.execPath, SDK_DIR, tmpdir()];

function expectPlaced(seen: Seen, s: SpawnSpec): void {
  expect(seen.argv[0]).toBe(CLAUDE_IMAGE_CLI);
  expect(seen.opts.cwd).toBe(s.cwd);
  expect(seen.opts.env).toMatchObject({
    PATH: IMAGE_PATH,
    HOME: s.homeDir,
    CLAUDE_CONFIG_DIR: s.homeDir,
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
  });
  // The MCP bearer is in neither: it is mounted over the CLI's stdin.
  expect(Object.values(seen.opts.env ?? {})).not.toContain(MCP_TOKEN);
  const argv = seen.argv.join("\n");
  for (const secret of [TOKEN, MCP_TOKEN]) {
    expect(argv.includes(secret), "a secret on argv").toBe(false);
  }
  for (const host of HOST_PATHS) expect(argv).not.toContain(host);
}

describe("a session an executor places (a container's)", () => {
  test("spawn starts the image's CLI in the session's paths; the secrets only in its env", async () => {
    const ex = new Placing();
    const s = placed();
    expect(await createClaudeSdkAdapter().spawn(s, ex)).toMatchObject({
      ok: false,
      error: { class: "spawn_failed" },
    });
    expect(ex.seen).toHaveLength(1);
    const [seen] = ex.seen;
    if (seen === undefined) throw new Error("no exec");
    expectPlaced(seen, s);
  });

  test("adopt resumes with the same CLI, paths and env", async () => {
    const ex = new Placing();
    const s = { ...placed(), resumeRunnerSessionId: "rsid-1" };
    await createClaudeSdkAdapter().adopt(s, ex);
    const [seen] = ex.seen;
    if (seen === undefined) throw new Error("no exec");
    expectPlaced(seen, s);
    expect(seen.argv).toContain("--resume=rsid-1");
  });

  test("health runs the image's CLI --version in the placed session's own dirs", async () => {
    const ex = new Placing();
    const at = { cwd: ROOT, tmp: `${ROOT}/.frm/tmp` };
    expect((await createClaudeSdkAdapter().health(ex, at)).ok).toBe(false);
    expect(ex.seen).toEqual([
      {
        argv: [CLAUDE_IMAGE_CLI, "--version"],
        opts: {
          cwd: at.cwd,
          env: { CLAUDE_CONFIG_DIR: at.tmp, PATH: IMAGE_PATH },
          stdin: "ignore",
        },
      },
    ]);
  });

  test("a stand-in CLI still wins, as the fixture's command does", async () => {
    const ex = new Placing();
    const stub = "/stand-in/stub-cli.mjs";
    await createClaudeSdkAdapter({
      pathToExecutable: stub,
      executable: "node",
    }).spawn(placed(), ex);
    expect(ex.seen[0]?.argv.slice(0, 2)).toEqual(["node", stub]);
  });
});

const BUNDLED = bundledBinary();

describe.skipIf(BUNDLED === undefined)("this host (no placement)", () => {
  test("spawn and health start the SDK's bundled binary, as before; never the image's path", async () => {
    const ex = new Recorder();
    const s: SpawnSpec = {
      ...placed(),
      cwd: tmpdir(),
      homeDir: tmpdir(),
      env: { PATH: process.env["PATH"] ?? "", CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    };
    await createClaudeSdkAdapter().spawn(s, ex);
    await createClaudeSdkAdapter().health(ex);
    expect(ex.seen.map((x) => x.argv[0])).toEqual([BUNDLED, BUNDLED]);
    expect(ex.seen[1]?.argv).toEqual([BUNDLED, "--version"]);
    const argv = ex.seen.flatMap((x) => x.argv).join("\n");
    expect(argv).not.toContain(CLAUDE_IMAGE_CLI);
    expect(argv.includes(TOKEN)).toBe(false);
  });
});
