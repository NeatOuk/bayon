// Live evidence: the real opencode 1.18.32 against a real Ollama host, through
// the real turn host and local executor. CI never sets FRM_REAL_RUNNER, so this is skipped there.
// The Ollama address is operator data: it comes from the environment and nowhere else, and the
// server must serve a context opencode fits in (OLLAMA_CONTEXT_LENGTH ≥ 32768; spike fact 15).
//   FRM_REAL_RUNNER=1 FRM_OLLAMA_BASE_URL=http://<ollama-host>:11434/v1 \
//     pnpm exec vitest run packages/runners/src/adapters/opencode/live.test.ts
//   FRM_OPENCODE_MODEL=ollama/<model> picks the model (default: the cheap row's).
//   FRM_RECORD=1 also writes the host's raw stdout to fixtures/opencode/recorded/ (gitignored).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type {
  MappedEvent,
  RawRecord,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import { createOpencodeAdapter } from "./adapter.js";
import { DEFAULTS, MODELS, OLLAMA_BASE_URL_ENV } from "./registration.js";

const LIVE = process.env["FRM_REAL_RUNNER"] === "1";
const RECORD = process.env["FRM_RECORD"] === "1";
const BASE_URL = process.env["FRM_OLLAMA_BASE_URL"] ?? "";
const MODEL =
  process.env["FRM_OPENCODE_MODEL"] ??
  MODELS.find((m) => m.tier === "cheap")?.model ??
  "";
const RECORDED = fileURLToPath(
  new URL("../../../fixtures/opencode/recorded/", import.meta.url),
);

describe.skipIf(!LIVE)("the live opencode runner", { timeout: 900_000 }, () => {
  let root = "";
  beforeAll(() => {
    if (BASE_URL === "")
      throw new Error("set FRM_OLLAMA_BASE_URL: there is no default address");
    root = realpathSync(mkdtempSync(join(tmpdir(), "frm-opencode-live-")));
  });
  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });
  const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });
  const adapter = createOpencodeAdapter({ graceMs: 5_000 });
  const raw: string[] = [];

  /** Bayon's local layout: a worktree of a bare mirror. Returns the worktree. */
  function repo(): string {
    const seed = join(root, "seed");
    const mirror = join(root, "mirror.git");
    const wt = join(root, "wt");
    mkdirSync(seed, { recursive: true });
    writeFileSync(
      join(seed, "add.js"),
      "export function add(a, b) {\n  return a - b;\n}\n",
    );
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=frm", "-c", "user.email=frm@localhost", ...args],
        { cwd, stdio: "ignore" },
      );
    git(root, "init", "-q", "--bare", mirror);
    git(seed, "init", "-q");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", mirror, "HEAD:main");
    git(mirror, "worktree", "add", "-q", wt, "main");
    return wt;
  }

  function reader(records: AsyncIterable<RawRecord>) {
    const iterator = records[Symbol.asyncIterator]();
    const mapper = adapter.createMapper({ prices: MODELS });
    let offset = 0;
    /** Maps records until the run's terminal, or the stream's end. */
    return async (): Promise<MappedEvent[]> => {
      const out: MappedEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return out;
        const text = new TextDecoder().decode(next.value.bytes);
        raw.push(text);
        out.push(
          ...mapper.map({ offset, bytes: next.value.bytes, ts: Date.now() }),
        );
        offset += next.value.bytes.length + 1;
        if (out.some((e) => e.kind === "terminal")) return out;
      }
    };
  }

  const specOf = (cwd: string, o: Partial<SpawnSpec> = {}): SpawnSpec => ({
    sessionId: "01JLIVEOPENCODE",
    cwd,
    homeDir: join(root, "home"),
    env: {
      PATH: process.env["PATH"] ?? "",
      [OLLAMA_BASE_URL_ENV]: BASE_URL,
      GIT_AUTHOR_NAME: "agent",
      GIT_AUTHOR_EMAIL: "agent@frm",
      GIT_COMMITTER_NAME: "agent",
      GIT_COMMITTER_EMAIL: "agent@frm",
    },
    model: MODEL,
    flags: { ...DEFAULTS },
    ...o,
  });

  let handle: SessionHandle | undefined;
  let next: (() => Promise<MappedEvent[]>) | undefined;
  let spec: SpawnSpec | undefined;

  test("one plain turn ends on opencode's own end_turn, with reported spend", async () => {
    spec = specOf(repo());
    const home = await adapter.prepareHome(spec, local);
    expect(home.ok).toBe(true);
    const h = await adapter.spawn(spec, local);
    if (!h.ok) throw new Error(h.error.message);
    handle = h.value;
    next = reader(adapter.records(handle));
    expect(handle.runnerSessionId).toMatch(/^ses_/);
    const sent = await adapter.send(handle, {
      runId: "live-1",
      text: "Reply with the single word OK.",
      promptPath: "/dev/null",
    });
    expect(sent.ok).toBe(true);
    const events = await next();
    const terminal = events.find((e) => e.kind === "terminal");
    expect(terminal?.payload).toMatchObject({
      outcome: "ok",
      spend: { cost_source: "reported" },
    });
    expect(events.some((e) => e.kind === "assistant_text")).toBe(true);
  });

  test("interrupt during a running tool: opencode's own cancelled, then the session goes on", async () => {
    if (handle === undefined || next === undefined)
      throw new Error("no session");
    await adapter.send(handle, {
      runId: "live-2",
      text: 'Call the bash tool with exactly {"command": "sleep 30", "description": "wait"}. Then reply DONE.',
      promptPath: "/dev/null",
    });
    const it = next;
    const seen = it();
    // Interrupt once the tool is visibly running: the mapper's tool_call is enough.
    for (
      let i = 0;
      i < 600 && !raw.some((l) => l.includes('"in_progress"'));
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await adapter.interrupt(handle)).toEqual({
      ok: true,
      value: undefined,
    });
    const events = await seen;
    expect(events.find((e) => e.kind === "terminal")?.payload).toMatchObject({
      outcome: "interrupted",
    });
  });

  /**
   * One turn asking the model to run `command` in its shell, once. The evidence is what opencode's
   * shell reported for that exact command: a model that never ran it proves nothing.
   */
  async function once(runId: string, command: string): Promise<string> {
    // A fresh session each: on a 4096-token Ollama context a long session loses the prompt.
    if (!existsSync(join(root, "wt"))) repo();
    const fresh = {
      ...specOf(join(root, "wt")),
      homeDir: join(root, `home-${runId}`),
    };
    expect((await adapter.prepareHome(fresh, local)).ok).toBe(true);
    const h = await adapter.spawn(fresh, local);
    if (!h.ok) throw new Error(h.error.message);
    const read = reader(adapter.records(h.value));
    const from = raw.length;
    await adapter.send(h.value, {
      runId,
      text: `Call the bash tool with exactly ${JSON.stringify({ command, description: "check" })}. Then reply DONE.`,
      promptPath: "/dev/null",
    });
    await read();
    await adapter.stop(h.value, "graceful");
    const ran = raw
      .slice(from)
      .map((l) => {
        try {
          return JSON.parse(l) as {
            params?: { update?: Record<string, unknown> };
          };
        } catch {
          return {};
        }
      })
      .map((m) => m.params?.update)
      .filter(
        (u) =>
          u?.["sessionUpdate"] === "tool_call_update" &&
          (u["status"] === "completed" || u["status"] === "failed"),
      );
    if (ran.length === 0)
      throw new Error(`the model ran no tool for: ${command}`);
    return JSON.stringify(ran);
  }

  /** A model may decline a command once; it gets one more fresh session to run it. */
  async function shell(runId: string, command: string): Promise<string> {
    try {
      return await once(runId, command);
    } catch {
      return once(`${runId}-again`, command);
    }
  }

  test("Seatbelt: writes outside the worktree, a mirror hook and the mirror's config are refused", async () => {
    if (!existsSync(join(root, "wt"))) repo();
    const mirror = join(root, "mirror.git");
    const outside = join(root, "outside.txt");
    const hook = join(mirror, "hooks", "post-commit");
    const config = readFileSync(join(mirror, "config"), "utf8");
    expect(await shell("live-s1", `echo x > ${outside}`)).toMatch(
      /operation not permitted/i,
    );
    expect(existsSync(outside)).toBe(false);
    expect(await shell("live-s2", `echo 'touch ${outside}' > ${hook}`)).toMatch(
      /operation not permitted/i,
    );
    expect(existsSync(hook)).toBe(false);
    expect(
      await shell(
        "live-s3",
        `echo '[core] hooksPath = /tmp' >> ${join(mirror, "config")}`,
      ),
    ).toMatch(/operation not permitted/i);
    expect(readFileSync(join(mirror, "config"), "utf8")).toBe(config);
  });

  test("Seatbelt: an edit and a commit in the worktree work", async () => {
    await shell(
      "live-s4",
      "sed -i '' 's/a - b/a + b/' add.js && git commit -qam fix && git log -1 --format=%s",
    );
    expect(
      execFileSync(
        "git",
        ["-C", join(root, "mirror.git"), "log", "-1", "--format=%s", "main"],
        {
          encoding: "utf8",
        },
      ).trim(),
    ).toBe("fix");
  });

  test("MCP goes through the host's proxy: the server sees the bearer, opencode's env never has it", async () => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const m = JSON.parse(body || "{}") as {
          id?: number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (req.method !== "POST" || m.id === undefined) {
          res.writeHead(req.method === "POST" ? 202 : 405);
          return res.end();
        }
        const result =
          m.method === "initialize"
            ? {
                protocolVersion: m.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "probe", version: "1" },
              }
            : m.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "conformance_echo",
                      inputSchema: { type: "object" },
                    },
                  ],
                }
              : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    try {
      if (!existsSync(join(root, "wt"))) repo();
      const s = {
        ...specOf(join(root, "wt")),
        homeDir: join(root, "home-mcp"),
        mcp: {
          url: `http://127.0.0.1:${port}/mcp`,
          token: "live-bearer",
          tools: ["conformance_echo"],
        },
      };
      expect((await adapter.prepareHome(s, local)).ok).toBe(true);
      const h = await adapter.spawn(s, local);
      if (!h.ok) throw new Error(h.error.message);
      const read = reader(adapter.records(h.value));
      await adapter.send(h.value, {
        runId: "live-mcp",
        text: "Reply with the single word OK.",
        promptPath: "/dev/null",
      });
      await read();
      await adapter.stop(h.value, "graceful");
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set(["Bearer live-bearer"]));
      expect(raw.join("\n")).not.toContain("live-bearer");
    } finally {
      server.close();
    }
  });

  test("stop, then adopt by the session id: a turn runs on the resumed session", async () => {
    if (handle === undefined || spec === undefined)
      throw new Error("no session");
    await adapter.stop(handle, "graceful");
    await handle.exited;
    const adopted = await adapter.adopt(
      { ...spec, resumeRunnerSessionId: handle.runnerSessionId },
      local,
    );
    if (!adopted.ok) throw new Error(adopted.error.message);
    handle = adopted.value;
    next = reader(adapter.records(handle));
    await adapter.send(handle, {
      runId: "live-3",
      text: "Reply with the single word OK.",
      promptPath: "/dev/null",
    });
    const events = await next();
    expect(events.find((e) => e.kind === "terminal")?.payload).toMatchObject({
      outcome: "ok",
    });
    await adapter.stop(handle, "graceful");
  });

  afterAll(() => {
    if (!RECORD) return;
    mkdirSync(RECORDED, { recursive: true });
    const text = raw.join("\n");
    if (text.includes(BASE_URL.replace(/\/v1$/, ""))) {
      throw new Error(
        "the recording holds the Ollama address: scrub before promoting",
      );
    }
    writeFileSync(join(RECORDED, `live-${Date.now()}.jsonl`), `${text}\n`);
  });
});
