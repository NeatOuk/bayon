// The turn host on its own, driving the stand-in opencode: the handshake,
// the relay and frames, the structured-output check, and every fatal path.
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_OUTPUT_JSON_SCHEMA } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import {
  ProviderBlock,
  envRefsOf,
  hostEnv,
  ownDirs,
  sessionConfig,
} from "./home.js";
import { HOST_FAILURE, encodeOp, hostArgv, type HostOp } from "./host.js";
import { DEFAULTS } from "./registration.js";
import { STUB_OPENCODE } from "./testing/stub.js";
import { PS_ARGS, hostDirOf, parsePs } from "./tool-groups.js";

const MODEL = "ollama/gemma4:26b";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Host = {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: () => Record<string, unknown>[];
  readonly stderr: () => string;
  readonly waitFor: (
    pred: (l: Record<string, unknown>) => boolean,
    ms?: number,
  ) => Promise<Record<string, unknown>>;
  readonly exited: Promise<number | null>;
  readonly send: (op: HostOp) => void;
  readonly home: string;
  readonly cwd: string;
};

function startHost(
  o: {
    readonly resume?: string | null;
    readonly model?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly policy?: "reviewer";
    readonly home?: string;
    readonly mcpUrl?: string;
    readonly token?: string;
    readonly cwd?: string;
  } = {},
): Host {
  const root = mkdtempSync(join(tmpdir(), "frm-oc-host-"));
  dirs.push(root);
  const home = o.home ?? join(root, "home");
  const cwd = o.cwd ?? mkdtempSync(join(root, "wt-"));
  const config = sessionConfig({
    model: MODEL,
    provider: "ollama",
    modelId: "gemma4:26b",
    block: ProviderBlock.parse(DEFAULTS.providers.ollama),
    readOnly: false,
    mcpTools: ["conformance_echo"],
    ownDirs: ownDirs(home),
    ...(o.policy === undefined
      ? {}
      : { policy: { role: "reviewer", groups: ["git_read"] } }),
  });
  const block = ProviderBlock.parse(DEFAULTS.providers.ollama);
  const { env, allow } = hostEnv(
    { PATH: process.env["PATH"] ?? "", SOME_API_KEY: "sk-never", ...o.env },
    home,
    config,
    o.token,
    envRefsOf(block),
  );
  const [node, ...args] = hostArgv(process.execPath, {
    v: 1,
    home,
    bin: [process.execPath, STUB_OPENCODE],
    model: o.model ?? MODEL,
    resume: o.resume ?? null,
    graceMs: 300,
    mcpUrl: o.mcpUrl ?? null,
    allow: [...allow, ...Object.keys(o.env ?? {})],
  });
  const proc = spawn(node, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const waiters: (() => void)[] = [];
  proc.stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
    for (const w of waiters.splice(0)) w();
  });
  proc.stderr.on("data", (c: Buffer) => {
    err += c.toString("utf8");
  });
  const lines = () =>
    out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const exited = new Promise<number | null>((resolve) =>
    proc.once("exit", (code) => {
      for (const w of waiters.splice(0)) w();
      resolve(code);
    }),
  );
  return {
    proc,
    lines,
    stderr: () => err,
    exited,
    home,
    cwd,
    send: (op) => proc.stdin.write(encodeOp(op)),
    async waitFor(pred, ms = 10_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = lines().find(pred);
        if (hit !== undefined) return hit;
        if (Date.now() > deadline || proc.exitCode !== null)
          throw new Error(`not seen; stdout:\n${out}\nstderr:\n${err}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
  };
}

const type = (t: string) => (l: Record<string, unknown>) => l["type"] === t;
const answerTo = (id: unknown) => (l: Record<string, unknown>) =>
  l["id"] === id && l["method"] === undefined;

describe("the handshake", () => {
  test("a new session: initialize, session/new, the model set, then frm.host.start", async () => {
    const h = startHost();
    const start = await h.waitFor(type("frm.host.start"));
    expect(start).toMatchObject({ v: 1, resumed: false, model: MODEL });
    expect(String(start["runner_session_id"])).toMatch(/^ses_stub/);
    // The handshake's answers are relayed, and come before the frame.
    const lines = h.lines();
    const before = lines.slice(0, lines.findIndex(type("frm.host.start")));
    expect(
      before.flatMap((l) => (l["method"] === undefined ? [l["id"]] : [])),
    ).toEqual([1, 2, 3]);
    h.proc.stdin.end();
    expect(await h.exited).toBe(0);
  });

  test("the home is prepared by the host alone, opencode's config dir read-only", async () => {
    const h = startHost();
    await h.waitFor(type("frm.host.start"));
    expect(statSync(join(h.home, "xdg/config/opencode")).mode & 0o777).toBe(
      0o555,
    );
    for (const d of ["home", "tmp", "xdg/data", "xdg/cache", "xdg/state"]) {
      expect(existsSync(join(h.home, d))).toBe(true);
    }
    h.proc.stdin.end();
    await h.exited;
  });

  test("resume re-attaches the stored session in a new process", async () => {
    const first = startHost();
    const start = await first.waitFor(type("frm.host.start"));
    first.proc.stdin.end();
    await first.exited;
    const again = startHost({
      home: first.home,
      resume: String(start["runner_session_id"]),
    });
    expect(await again.waitFor(type("frm.host.start"))).toMatchObject({
      runner_session_id: start["runner_session_id"],
      resumed: true,
    });
    again.proc.stdin.end();
    await again.exited;
  });

  test("an unknown session to resume fails the host: no start frame, exit 70, the reason on stderr", async () => {
    const h = startHost({ resume: "ses_nope" });
    expect(await h.exited).toBe(HOST_FAILURE);
    expect(h.lines().some(type("frm.host.start"))).toBe(false);
    expect(h.lines().some(type("frm.host.exit"))).toBe(true);
    expect(h.stderr()).toContain("session/resume: ");
  });

  test("a model the provider lacks fails the host the same way", async () => {
    const h = startHost({ model: "ollama/nope" });
    expect(await h.exited).toBe(HOST_FAILURE);
    expect(h.stderr()).toContain("model ollama/nope");
  });

  test("an opencode that cannot start: an exit frame and 127", async () => {
    const root = mkdtempSync(join(tmpdir(), "frm-oc-host-"));
    dirs.push(root);
    const [node, ...args] = hostArgv(process.execPath, {
      v: 1,
      home: join(root, "home"),
      bin: [join(root, "no-such-opencode")],
      model: MODEL,
      resume: null,
      graceMs: 100,
      mcpUrl: null,
      allow: ["PATH"],
    });
    const proc = spawn(node, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    const code = await new Promise((r) => proc.once("exit", r));
    expect(code).toBe(127);
    expect(out).toContain('"frm.host.exit"');
  });
});

describe("turns", () => {
  test("a turn frame names the prompt's rpc id; opencode's answer to it follows", async () => {
    const h = startHost();
    await h.waitFor(type("frm.host.start"));
    h.send({
      op: "turn",
      run_id: "run-1",
      text: "Reply with the single word OK.",
    });
    const turn = await h.waitFor(type("frm.host.turn"));
    expect(turn).toMatchObject({
      run_id: "run-1",
      model: MODEL,
      output: false,
    });
    expect(await h.waitFor(answerTo(turn["rpc_id"]))).toMatchObject({
      result: { stopReason: "end_turn" },
    });
    h.proc.stdin.end();
    expect(await h.exited).toBe(0);
  });

  test("interrupt: the frame, then session/cancel; opencode answers cancelled", async () => {
    const h = startHost();
    await h.waitFor(type("frm.host.start"));
    h.send({ op: "turn", run_id: "run-1", text: "Run `sleep 30`, then DONE." });
    const turn = await h.waitFor(type("frm.host.turn"));
    await h.waitFor((l) => JSON.stringify(l).includes('"in_progress"'));
    h.send({ op: "interrupt", run_id: "other-run" }); // not this run: ignored
    h.send({ op: "interrupt", run_id: "run-1" });
    await h.waitFor(type("frm.host.interrupt"));
    expect(await h.waitFor(answerTo(turn["rpc_id"]))).toMatchObject({
      result: { stopReason: "cancelled" },
    });
    expect(h.lines().filter(type("frm.host.interrupt"))).toHaveLength(1);
    h.proc.stdin.end();
    await h.exited;
  });

  test("a permission request is refused for the client, and the turn goes on to its end", async () => {
    const h = startHost({ policy: "reviewer", env: { FRM_STUB_ASK: "1" } });
    await h.waitFor(type("frm.host.start"));
    h.send({
      op: "turn",
      run_id: "run-1",
      text: "Run the shell command `touch MARKER` once.",
    });
    const turn = await h.waitFor(type("frm.host.turn"));
    await h.waitFor((l) => l["method"] === "session/request_permission");
    expect(await h.waitFor(answerTo(turn["rpc_id"]))).toMatchObject({
      result: { stopReason: "end_turn" },
    });
    expect(existsSync(join(h.cwd, "MARKER"))).toBe(false);
    h.proc.stdin.end();
    await h.exited;
  });

  test("structured output: a valid answer is written 0600 and the check precedes the answer", async () => {
    const h = startHost();
    await h.waitFor(type("frm.host.start"));
    const path = join(h.cwd, "..", "review.json");
    h.send({
      op: "turn",
      run_id: "run-1",
      text: "Review the file add.js in the current directory for bugs.",
      instruction: "[opencode-output/1]",
      output: { schema: REVIEW_OUTPUT_JSON_SCHEMA, path },
    });
    const turn = await h.waitFor(type("frm.host.turn"));
    expect(turn["output"]).toBe(true);
    await h.waitFor(answerTo(turn["rpc_id"]));
    const lines = h.lines();
    const check = lines.findIndex(type("frm.host.output"));
    const answer = lines.findIndex(answerTo(turn["rpc_id"]));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(answer);
    expect(lines[check]).toMatchObject({ ok: true, path, issues: [] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      findings: [{ file: "add.js" }],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    h.proc.stdin.end();
    await h.exited;
  });

  test("structured output: an answer that fails the schema writes no file", async () => {
    const h = startHost();
    await h.waitFor(type("frm.host.start"));
    const path = join(h.cwd, "..", "never.json");
    h.send({
      op: "turn",
      run_id: "run-1",
      text: "Reply with the single word OK.",
      output: { schema: REVIEW_OUTPUT_JSON_SCHEMA, path },
    });
    expect(await h.waitFor(type("frm.host.output"))).toMatchObject({
      ok: false,
      path: null,
      issues: ["the final answer is not JSON"],
    });
    expect(existsSync(path)).toBe(false);
    h.proc.stdin.end();
    await h.exited;
  });
});

describe("tool process groups", () => {
  /** A process in a group of its own, with its start time as ps reports it. */
  function leader(cwd: string): {
    pid: number;
    start: string;
    gone: Promise<unknown>;
  } {
    const p = spawn("sleep", ["30"], { cwd, detached: true, stdio: "ignore" });
    const pid = p.pid ?? 0;
    const rows = parsePs(
      execFileSync("ps", [...PS_ARGS], { encoding: "utf8" }),
    );
    const start = rows.find((r) => r.pid === pid)?.start ?? "";
    return { pid, start, gone: new Promise((r) => p.once("exit", r)) };
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("a host reaps the groups a dead host recorded that are this session's, and nothing else", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-oc-host-")));
    dirs.push(root);
    const home = join(root, "home");
    const wt = join(root, "wt");
    const elsewhere = join(root, "elsewhere");
    for (const d of [home, wt, elsewhere]) mkdirSync(d, { recursive: true });
    const tool = leader(wt);
    // A forged entry: a real, same-user process group that is not this session's (its cwd is
    // elsewhere), recorded with its true start time. Stands in for the supervisor.
    const bystander = leader(elsewhere);
    mkdirSync(hostDirOf(home), { recursive: true });
    writeFileSync(
      join(hostDirOf(home), "tool-groups.json"),
      JSON.stringify([
        { pgid: tool.pid, start: tool.start },
        { pgid: bystander.pid, start: bystander.start },
        // A recycled pid: same number, another start time.
        { pgid: process.pid, start: "Mon Jan  1 00:00:00 2001" },
      ]),
    );
    const h = startHost({ home, cwd: wt });
    await h.waitFor(type("frm.host.start"));
    await tool.gone;
    expect(alive(bystander.pid)).toBe(true);
    expect(alive(process.pid)).toBe(true);
    expect(existsSync(join(hostDirOf(home), "tool-groups.json"))).toBe(false);
    process.kill(-bystander.pid, "SIGKILL");
    h.proc.stdin.end();
    await h.exited;
  });

  test("a record in the session home is ignored: only the host's own dir counts", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-oc-host-")));
    dirs.push(root);
    const home = join(root, "home");
    const wt = join(root, "wt");
    for (const d of [home, wt]) mkdirSync(d, { recursive: true });
    const tool = leader(wt);
    writeFileSync(
      join(home, "tool-groups.json"),
      JSON.stringify([{ pgid: tool.pid, start: tool.start }]),
    );
    const h = startHost({ home, cwd: wt });
    await h.waitFor(type("frm.host.start"));
    expect(alive(tool.pid)).toBe(true);
    process.kill(-tool.pid, "SIGKILL");
    h.proc.stdin.end();
    await h.exited;
    expect(statSync(hostDirOf(home)).mode & 0o777).toBe(0o700);
  });
});

describe("the MCP proxy", () => {
  async function server(): Promise<{
    url: string;
    seen: (string | undefined)[];
    close: () => void;
  }> {
    const seen: (string | undefined)[] = [];
    const s = createServer((req, res) => {
      seen.push(req.headers.authorization);
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const m = JSON.parse(body || "{}") as { id?: number; method?: string };
        if (m.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: m.id,
            result:
              m.method === "tools/call"
                ? { content: [{ type: "text", text: "echoed" }] }
                : {},
          }),
        );
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const address = s.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      seen,
      close: () => s.close(),
    };
  }

  test("opencode reaches it with this session's proxy bearer; the server gets the real one", async () => {
    const mcp = await server();
    try {
      const h = startHost({ mcpUrl: mcp.url, token: "the-bearer" });
      await h.waitFor(type("frm.host.start"));
      h.send({
        op: "turn",
        run_id: "run-1",
        text: 'Call the conformance_echo tool on the foreman MCP server once with the argument nonce set to "n1", then reply DONE.',
      });
      await h.waitFor((l) => JSON.stringify(l).includes("echoed"));
      expect(mcp.seen.length).toBeGreaterThan(0);
      expect(new Set(mcp.seen)).toEqual(new Set(["Bearer the-bearer"]));
      const stub = join(h.home, "xdg/data/opencode/stub");
      const names = JSON.parse(
        readFileSync(join(stub, "env-names-0.json"), "utf8"),
      ) as string[];
      expect(names.filter((n) => n.startsWith("FRM_MCP"))).toEqual([]);
      expect(readFileSync(join(stub, "config-0.json"), "utf8")).not.toMatch(
        /bearer|mcp/i,
      );
      h.proc.stdin.end();
      await h.exited;
    } finally {
      mcp.close();
    }
  });

  test("a caller without this session's proxy bearer is refused 401, and nothing is forwarded", async () => {
    const mcp = await server();
    try {
      const h = startHost({ mcpUrl: mcp.url, token: "the-bearer" });
      await h.waitFor(type("frm.host.start"));
      const [proxy] = JSON.parse(
        readFileSync(
          join(h.home, "xdg/data/opencode/stub/mcp-urls.json"),
          "utf8",
        ),
      ) as string[];
      const post = (headers: Record<string, string>) =>
        fetch(proxy ?? "", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }).then((r) => r.status);
      expect(await post({})).toBe(401);
      expect(await post({ authorization: "Bearer the-bearer" })).toBe(401);
      expect(await post({ authorization: "Bearer wrong" })).toBe(401);
      expect(mcp.seen).toEqual([]);
      h.proc.stdin.end();
      await h.exited;
    } finally {
      mcp.close();
    }
  });
});

describe("fatal paths", () => {
  test("stdin EOF mid-turn: the host cancels, opencode exits on its own, the host with its status", async () => {
    const h = startHost();
    await h.waitFor(type("frm.host.start"));
    h.send({ op: "turn", run_id: "run-1", text: "Run `sleep 30`." });
    await h.waitFor((l) => JSON.stringify(l).includes('"in_progress"'));
    h.proc.stdin.end();
    expect(await h.exited).toBe(0);
    const lines = h.lines();
    expect(lines.some((l) => JSON.stringify(l).includes('"cancelled"'))).toBe(
      true,
    );
    expect(lines.at(-1)).toMatchObject({ type: "frm.host.exit", code: 0 });
  });

  test("SIGTERM to the host ends opencode the same way", async () => {
    const h = startHost();
    await h.waitFor(type("frm.host.start"));
    h.proc.kill("SIGTERM");
    expect(await h.exited).toBe(0);
    expect(h.lines().at(-1)).toMatchObject({ type: "frm.host.exit" });
  });

  test("opencode dying mid-turn: an exit frame and its status, no answer to the prompt", async () => {
    const h = startHost({ env: { FRM_STUB_CRASH: "1" } });
    await h.waitFor(type("frm.host.start"));
    h.send({ op: "turn", run_id: "run-1", text: "Run `sleep 30`." });
    const turn = await h.waitFor(type("frm.host.turn"));
    expect(await h.exited).toBe(0);
    expect(h.lines().some(answerTo(turn["rpc_id"]))).toBe(false);
    expect(h.lines().at(-1)).toMatchObject({ type: "frm.host.exit" });
    // Residual (design §13): a tool whose opencode died before its group was recorded outlives
    // it until the next host starts in this home. The test cleans up after itself.
    const pid = Number(
      readFileSync(join(h.home, "xdg/data/opencode/stub/tool-pid"), "utf8"),
    );
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  });

  test("an op that is not JSON fails the host with 70", async () => {
    const h = startHost();
    await h.waitFor(type("frm.host.start"));
    h.proc.stdin.write("not json\n");
    expect(await h.exited).toBe(HOST_FAILURE);
    expect(h.stderr()).toContain("an op that is not JSON");
  });

  test("the host's argv holds no secret, and the password it gives opencode never reaches stdout", async () => {
    const h = startHost();
    await h.waitFor(type("frm.host.start"));
    h.proc.stdin.end();
    await h.exited;
    const stub = join(h.home, "xdg/data/opencode/stub");
    const env = JSON.parse(
      readFileSync(join(stub, "env-0.json"), "utf8"),
    ) as Record<string, string>;
    expect(env["OPENCODE_SERVER_PASSWORD"]).toMatch(/^[0-9a-f]{64}$/);
    const argv = JSON.parse(
      readFileSync(join(stub, "argv-0.json"), "utf8"),
    ) as string[];
    // opencode's own server on a port the host picked, so the sandbox can name it.
    expect(argv.slice(0, 4)).toEqual([
      "acp",
      "--hostname",
      "127.0.0.1",
      "--port",
    ]);
    expect(Number(argv[4])).toBeGreaterThan(0);
    // The host's one argument is its config: no secret has anywhere to be.
    expect(
      Object.keys(JSON.parse(h.proc.spawnargs.at(-1) ?? "{}")).toSorted(),
    ).toEqual([
      "allow",
      "bin",
      "graceMs",
      "home",
      "mcpUrl",
      "model",
      "resume",
      "v",
    ]);
  });
});
