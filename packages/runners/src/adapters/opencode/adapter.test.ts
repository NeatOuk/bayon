// The adapter on its stand-in, through the real turn host and the real local executor: what spawn
// refuses before any process starts, the version pin, adopt, and the run lifecycle. Waits are on
// events and exits, each with a deadline; nothing sleeps.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_OUTPUT_JSON_SCHEMA } from "@bayon/core";
import { LocalExecutor, SESSION_GIT_ENV, SlotCounter } from "@bayon/executors";
import { afterEach, describe, expect, test } from "vitest";
import type { RunnerAdapter, SessionHandle, SpawnSpec } from "../../adapter.js";
import { createOpencodeAdapter } from "./adapter.js";
import { DEFAULTS, VERSION_LINE } from "./registration.js";
import { STUB_OPENCODE } from "./testing/stub.js";
import { hostDirOf } from "./tool-groups.js";

const WAIT_MS = 15_000;
const TOKEN = "frm-mcp-token-for-this-test";
const executor = new LocalExecutor({ id: "local", slots: new SlotCounter(8) });
const decoder = new TextDecoder();
const stub = (...extra: string[]) =>
  createOpencodeAdapter({
    bin: [process.execPath, STUB_OPENCODE, ...extra],
    graceMs: 300,
    ...(process.platform === "darwin" ? {} : { unsandboxed: true }),
  });

const roots: string[] = [];
const live: { adapter: RunnerAdapter; handle: SessionHandle }[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.adapter.stop(s.handle, "kill");
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function within<T>(p: Promise<T>, what: string, ms = WAIT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out: ${what}`)), ms).unref();
    }),
  ]);
}

function specOf(o: Partial<SpawnSpec> = {}): SpawnSpec {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-oc-")));
  roots.push(root);
  const cwd = join(root, "work");
  mkdirSync(cwd);
  return {
    sessionId: "01JSESSION",
    cwd,
    homeDir: join(root, "home"),
    env: { PATH: process.env["PATH"] ?? "" },
    model: "ollama/gemma4:26b",
    flags: { ...DEFAULTS },
    ...o,
  };
}

async function spawned(
  adapter: RunnerAdapter,
  spec: SpawnSpec,
): Promise<SessionHandle> {
  const home = await adapter.prepareHome(spec, executor);
  if (!home.ok) throw new Error(home.error.message);
  const h = await within(adapter.spawn(spec, executor), "spawn");
  if (!h.ok) throw new Error(h.error.message);
  live.push({ adapter, handle: h.value });
  return h.value;
}

/** Reads records until `pred` holds for one; returns every line read so far. */
async function readUntil(
  it: AsyncIterator<{ bytes: Uint8Array }>,
  pred: (line: string) => boolean,
): Promise<string[]> {
  const seen: string[] = [];
  for (;;) {
    const next = await within(it.next(), "a record");
    if (next.done === true) throw new Error(`ended; saw:\n${seen.join("\n")}`);
    const line = decoder.decode(next.value.bytes);
    seen.push(line);
    if (pred(line)) return seen;
  }
}

describe("refused before any process starts", () => {
  test.each<[string, Partial<SpawnSpec>, string]>([
    [
      "a model that is not provider/model",
      { model: "gemma4" },
      "provider/model",
    ],
    [
      "a provider it has no block for",
      { model: "openai/gpt-x" },
      "no provider block",
    ],
    [
      "extra roots it cannot grant",
      { extraRoots: ["/elsewhere"] },
      "cannot grant extra roots",
    ],
    ["an MCP-only session", { builtinTools: "none" }, "MCP-only"],
    [
      "an MCP server with no token",
      { mcp: { url: "http://127.0.0.1:1/mcp", token: "", tools: [] } },
      "empty token",
    ],
    [
      "a login in place",
      { grantedLogin: { path: "/x", value: "{}", mode: 0o600 } },
      "no login",
    ],
    [
      "a keyed provider, even by {env:} reference",
      {
        flags: {
          ...DEFAULTS,
          providers: {
            ollama: { options: { apiKey: "{env:OPENAI_API_KEY}" } },
          },
        },
      },
      "keyed providers are not supported yet",
    ],
    [
      "a model URL that is not http(s)",
      { modelSettings: { provider_url: "file:///etc/passwd" } },
      "must be http or https",
    ],
    [
      "a model URL on Bayon's own GUI port",
      { modelSettings: { provider_url: "http://127.0.0.1:5173/v1" } },
      "port 5173",
    ],
    [
      "a model setting it does not know, such as a key",
      { modelSettings: { api_key: "sk-x" } },
      "api_key",
    ],
  ])("%s", async (_what, override, message) => {
    const r = await stub().spawn(specOf(override), executor);
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    if (!r.ok) expect(r.error.message).toContain(message);
  });

  test("another version is drift: refused, and health says so too", async () => {
    const drift = stub("--frm-stub-version=1.18.34");
    const r = await drift.spawn(specOf(), executor);
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    if (!r.ok) expect(r.error.message).toContain("version drift");
    expect(await stub().health(executor)).toEqual({
      ok: true,
      value: { version: VERSION_LINE },
    });
  });
});

describe("a session", () => {
  test("spawn resolves with opencode's session id; two turns on one process", async () => {
    const adapter = stub();
    const h = await spawned(adapter, specOf());
    expect(h.runnerSessionId).toMatch(/^ses_stub/);
    const it = adapter.records(h)[Symbol.asyncIterator]();
    for (const runId of ["run-1", "run-2"]) {
      expect(
        await adapter.send(h, {
          runId,
          text: "Reply with the single word OK.",
          promptPath: "/p",
        }),
      ).toEqual({ ok: true, value: undefined });
      await readUntil(it, (l) => l.includes('"end_turn"'));
    }
    expect(adapter.caps().multiTurnInProcess).toBe(true);
  });

  test("a second send while a run is open is a conflict", async () => {
    const adapter = stub();
    const h = await spawned(adapter, specOf());
    const slow = { runId: "run-1", text: "Run `sleep 30`.", promptPath: "/p" };
    expect((await adapter.send(h, slow)).ok).toBe(true);
    expect(await adapter.send(h, { ...slow, runId: "run-2" })).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
    expect(await within(adapter.interrupt(h), "interrupt")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("an output schema the host cannot check is refused at send", async () => {
    const adapter = stub();
    const h = await spawned(adapter, specOf());
    const r = await adapter.send(h, {
      runId: "run-1",
      text: "x",
      promptPath: "/p",
      output: {
        schema: { type: "string", pattern: "^a" },
        path: "/tmp/x.json",
      },
    });
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    if (!r.ok) expect(r.error.message).toContain("pattern");
  });

  test("a review run writes SendSpec.output.path before its terminal is readable", async () => {
    const adapter = stub();
    const spec = specOf();
    const h = await spawned(adapter, spec);
    const path = join(spec.cwd, "..", "review.json");
    const it = adapter.records(h)[Symbol.asyncIterator]();
    await adapter.send(h, {
      runId: "run-1",
      text: "Review the file add.js in the current directory for bugs.",
      promptPath: "/p",
      output: { schema: REVIEW_OUTPUT_JSON_SCHEMA, path },
    });
    await readUntil(it, (l) => l.includes('"end_turn"'));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      findings: [{ file: "add.js" }],
    });
  });

  test("adopt resumes the same session in a new host; an unknown one is refused", async () => {
    const adapter = stub();
    const spec = specOf();
    const h = await spawned(adapter, spec);
    await adapter.stop(h, "graceful");
    expect(await within(h.exited, "exit")).toMatchObject({ code: 0 });
    const adopted = await within(
      adapter.adopt(
        { ...spec, resumeRunnerSessionId: h.runnerSessionId },
        executor,
      ),
      "adopt",
    );
    expect(adopted).toMatchObject({
      ok: true,
      value: { runnerSessionId: h.runnerSessionId },
    });
    if (adopted.ok) live.push({ adapter, handle: adopted.value });
    const unknown = await within(
      adapter.adopt(
        { ...specOf(), resumeRunnerSessionId: "ses_nope" },
        executor,
      ),
      "adopt unknown",
    );
    expect(unknown).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(await adapter.adopt(spec, executor)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("opencode's env, which every tool inherits, holds no MCP token and no secret", async () => {
    const adapter = stub();
    const spec = specOf({
      env: {
        PATH: process.env["PATH"] ?? "",
        ANTHROPIC_API_KEY: "sk-never-in-the-shell",
        FRM_SECRET_X: "never",
      },
      mcp: {
        url: "http://127.0.0.1:1/mcp",
        token: TOKEN,
        tools: ["conformance_echo"],
      },
    });
    await spawned(adapter, spec);
    const stubDir = join(spec.homeDir, "xdg/data/opencode/stub");
    const names = JSON.parse(
      readFileSync(join(stubDir, "env-names-0.json"), "utf8"),
    ) as string[];
    // Not even the proxy's address: opencode gets the MCP server over ACP, in memory.
    expect(names).not.toContain("FRM_MCP_PROXY_URL");
    expect(names).toContain("GIT_CONFIG_GLOBAL");
    for (const secret of [
      "FRM_MCP_TOKEN",
      "ANTHROPIC_API_KEY",
      "FRM_SECRET_X",
    ]) {
      expect(names).not.toContain(secret);
    }
    const env = JSON.parse(
      readFileSync(join(stubDir, "env-0.json"), "utf8"),
    ) as Record<string, string>;
    expect(env).not.toHaveProperty("FRM_MCP_TOKEN");
    for (const file of ["argv-0.json", "config-0.json"]) {
      expect(readFileSync(join(stubDir, file), "utf8")).not.toContain(TOKEN);
    }
  });

  // the floor is the shared helper's, whatever spec.env holds, and the identity passes.
  test("every tool's git gets the session git floor and the agents' identity, and nothing else of git", async () => {
    const adapter = stub();
    const identity = {
      GIT_AUTHOR_NAME: "Bayon Agent",
      GIT_AUTHOR_EMAIL: "agent@bayon.invalid",
      GIT_COMMITTER_NAME: "Bayon Agent",
      GIT_COMMITTER_EMAIL: "agent@bayon.invalid",
    };
    const spec = specOf({
      env: {
        PATH: process.env["PATH"] ?? "",
        ...identity,
        GIT_CONFIG_GLOBAL: "/home/operator/.gitconfig",
        GIT_SSH_COMMAND: "ssh -i /home/operator/.ssh/id",
      },
    });
    await spawned(adapter, spec);
    const stubDir = join(spec.homeDir, "xdg/data/opencode/stub");
    expect(
      JSON.parse(readFileSync(join(stubDir, "git-env-0.json"), "utf8")),
    ).toEqual({ ...identity, ...SESSION_GIT_ENV });
  });

  test("a model with its own provider URL runs on it, in place of the runner's {env:} address", async () => {
    const adapter = stub();
    const url = "http://10.0.0.7:11434/v1";
    const spec = specOf({ modelSettings: { provider_url: url } });
    await spawned(adapter, spec);
    const stubDir = join(spec.homeDir, "xdg/data/opencode/stub");
    const config = JSON.parse(
      readFileSync(join(stubDir, "config-0.json"), "utf8"),
    ) as { provider: Record<string, { options: { baseURL: string } }> };
    expect(config.provider["ollama"]?.options.baseURL).toBe(url);
    const names = JSON.parse(
      readFileSync(join(stubDir, "env-names-0.json"), "utf8"),
    ) as string[];
    // The runner-wide address is not read: nothing of it reaches opencode.
    expect(names).not.toContain("OLLAMA_BASE_URL");
    expect(readFileSync(join(stubDir, "config-0.json"), "utf8")).not.toContain(
      "{env:",
    );
  });

  test("without one, the runner's provider block stands", async () => {
    const adapter = stub();
    const spec = specOf();
    await spawned(adapter, spec);
    const config = JSON.parse(
      readFileSync(
        join(spec.homeDir, "xdg/data/opencode/stub/config-0.json"),
        "utf8",
      ),
    ) as { provider: Record<string, { options: { baseURL: string } }> };
    expect(config.provider["ollama"]?.options.baseURL).toBe(
      "{env:OLLAMA_BASE_URL}",
    );
  });

  test("stop(kill) mid-tool leaves no tool process behind", async () => {
    const adapter = stub();
    const spec = specOf();
    const h = await spawned(adapter, spec);
    const it = adapter.records(h)[Symbol.asyncIterator]();
    await adapter.send(h, {
      runId: "run-1",
      text: "Run `sleep 30`.",
      promptPath: "/p",
    });
    await readUntil(it, (l) => l.includes('"in_progress"'));
    const pidFile = join(spec.homeDir, "xdg/data/opencode/stub/tool-pid");
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    // The host records the tool's group while the turn runs.
    const record = join(hostDirOf(spec.homeDir), "tool-groups.json");
    for (let i = 0; i < 100 && !existsSync(record); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(readFileSync(record, "utf8")).toContain(`"pgid":${pid}`);
    await adapter.stop(h, "kill");
    for (let i = 0; i < 100 && alive(); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive()).toBe(false);
  });

  test("an executor that is neither local nor a container is refused", async () => {
    const remote = Object.create(executor, {
      kind: { value: "remote" },
    }) as typeof executor;
    const r = await stub().spawn(specOf(), remote);
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    if (!r.ok) expect(r.error.message).toContain("runs only inside a boundary");
  });

  test("interrupt with no run open is a no-op; there is no interactive takeover", async () => {
    const adapter = stub();
    const spec = specOf();
    const h = await spawned(adapter, spec);
    expect(await adapter.interrupt(h)).toEqual({ ok: true, value: undefined });
    expect(
      await adapter.interactiveResume(spec, "ses_x", executor),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("stop(kill) ends the host at once", async () => {
    const adapter = stub();
    const h = await spawned(adapter, specOf());
    await adapter.stop(h, "kill");
    expect(await within(h.exited, "exit")).toMatchObject({ signal: "SIGKILL" });
  });
});
