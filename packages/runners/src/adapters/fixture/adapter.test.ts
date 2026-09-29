import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "@bayon/core";
import {
  LocalExecutor,
  SESSION_GIT_ENV,
  SlotCounter,
  type Executor,
} from "@bayon/executors";
import { FakeExecutor, type FakeIo } from "@bayon/executors/testing";
import { afterAll, describe, expect, test } from "vitest";
import type {
  MappedEvent,
  RawRecord,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import { LOADED_PROCESS_BUDGETS } from "../../conformance/fixtures.js";
import {
  FIXTURE_MCP_TOKEN_ENV,
  FIXTURE_PROGRAM,
  createFixtureAdapter,
  createFixtureMapper,
  fixtureProgram,
  type FixtureScriptInput,
} from "./index.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-fixture-adapter-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const dir = (name: string) => join(root, `${name}-${++dirs}`);

/** Real processes run on real time: a deadline, never a sleep. */
async function within<T>(
  promise: Promise<T>,
  what: string,
  ms = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deadline passed: ${what}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A clock whose waits end at once: every grace period has already run out. */
const expired: Clock = { now: () => 0, after: async () => undefined };

const fake = new FakeExecutor({
  programs: {
    [FIXTURE_PROGRAM]: fixtureProgram,
    // Never exits on EOF; dies on any signal.
    stubborn: (io) =>
      new Promise<number>((resolve) =>
        io.signal.addEventListener("abort", () => resolve(0)),
      ),
  },
});
const adapter = createFixtureAdapter({ command: [FIXTURE_PROGRAM] });

function spec(
  overrides: Partial<SpawnSpec> & { script?: FixtureScriptInput } = {},
): SpawnSpec {
  const { script, ...rest } = overrides;
  // The supervisor creates the worktree and prepareHome creates the home before any spawn.
  const cwd = dir("cwd");
  const homeDir = dir("home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return {
    sessionId: "01SESSION",
    cwd,
    homeDir,
    env: {},
    model: "fixture-model",
    flags: script === undefined ? {} : { script },
    ...rest,
  };
}

/** Reads one process's records through a fresh mapper, run by run. */
function reader(records: AsyncIterable<RawRecord>) {
  const iterator = records[Symbol.asyncIterator]();
  const mapper = adapter.createMapper({ prices: [] });
  let offset = 0;
  return {
    /** Events up to and including the next terminal, or up to the end of stdout. */
    async run(): Promise<MappedEvent[]> {
      const out: MappedEvent[] = [];
      for (;;) {
        const next = await within(iterator.next(), "the next record");
        if (next.done === true) return out;
        const events = mapper.map({
          offset,
          bytes: next.value.bytes,
          ts: 1,
          partial: next.value.partial,
        });
        offset += next.value.bytes.length + 1;
        out.push(...events);
        if (events.some((e) => e.kind === "terminal")) return out;
      }
    },
    async rest(): Promise<number> {
      let count = 0;
      for (;;) {
        const next = await within(iterator.next(), "the end of stdout");
        if (next.done === true) return count;
        count += 1;
      }
    },
  };
}

async function spawned(
  ex: Executor,
  s: SpawnSpec,
  how: "spawn" | "adopt" = "spawn",
): Promise<SessionHandle> {
  const result = await adapter[how](s, ex);
  if (!result.ok) throw new Error(`${how} failed: ${result.error.message}`);
  return result.value;
}

const send = (h: SessionHandle, runId = "run-1") =>
  adapter.send(h, { runId, text: "go", promptPath: "/prompts/run.md" });

describe("the fixture adapter on FakeExecutor", () => {
  test("registers its own runner and models, apart from any other adapter", async () => {
    const reg = adapter.registration();
    expect(reg.runner).toMatchObject({
      id: "fixture",
      kind: "script",
      adapter: "fixture",
      versionDetected: "1",
    });
    expect(reg.models.map((m) => m.id)).toEqual([
      "fixture.complex",
      "fixture.standard",
      "fixture.cheap",
    ]);
    expect(adapter.caps()).toMatchObject({
      structuredEvents: true,
      resumable: true,
      multiTurnInProcess: true,
    });
    expect(await adapter.version()).toBe("1");
    expect(await adapter.health(fake)).toEqual({
      ok: true,
      value: { version: "1" },
    });
    expect(await adapter.estimateTokens("abcd")).toBe(2);
  });

  test("spawn resolves with the runner session id and no reader; runs map to the Done-when sequence", async () => {
    const s = spec();
    const h = await spawned(fake, s);
    expect(h.runnerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.executorRef).toMatch(/^fake:\d+$/);
    const read = reader(adapter.records(h));

    expect((await send(h)).ok).toBe(true);
    const run1 = await read.run();
    expect(run1.map((e) => e.kind)).toEqual([
      "session_init",
      "turn_start",
      "tool_call",
      "tool_result",
      "file_change",
      "runner_native",
      "turn_end",
      "terminal",
    ]);
    expect(run1[0]?.payload).toMatchObject({
      runner_session_id: h.runnerSessionId,
    });
    expect(run1.at(-1)?.payload).toMatchObject({
      outcome: "ok",
      spend: { tokens_in: 100, cost_usd: 0.001 },
    });
    expect(readFileSync(join(s.cwd, "README.md"), "utf8")).toBe(
      "fixture was here\n",
    );

    // A second run in the same process (§15 #3).
    expect((await send(h, "run-2")).ok).toBe(true);
    const run2 = await read.run();
    expect(run2[0]?.kind).toBe("turn_start");
    expect(run2.at(-1)?.payload).toMatchObject({ spend: { tokens_in: 100 } });

    await adapter.stop(h, "graceful");
    expect(await h.exited).toEqual({ code: 0, stderrTail: "" });
    expect(await read.rest()).toBe(0);
  });

  test("a send while a run is open is a conflict; release and interrupt end runs", async () => {
    const events = [{ kind: "turn_start", runner_type: "t", payload: {} }];
    const h = await spawned(
      fake,
      spec({
        script: {
          runs: [
            { events, gate: "release" },
            { events, then: "hang" },
          ],
        },
      }),
    );
    const read = reader(adapter.records(h));
    await send(h);
    expect(await send(h, "run-x")).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
    expect((await adapter.release(h)).ok).toBe(true);
    expect((await read.run()).at(-1)?.payload).toMatchObject({ outcome: "ok" });

    await send(h, "run-2");
    expect((await adapter.interrupt(h)).ok).toBe(true);
    expect((await read.run()).at(-1)).toMatchObject({
      kind: "terminal",
      payload: { outcome: "interrupted" },
    });
    await adapter.stop(h, "kill");
    expect(await h.exited).toMatchObject({ signal: "SIGKILL" });
    expect(await adapter.interrupt(h)).toMatchObject({
      ok: false,
      error: { class: "internal" },
    });
  });

  test("graceful stop interrupts the open run before closing stdin", async () => {
    const events = [{ kind: "turn_start", runner_type: "t", payload: {} }];
    const h = await spawned(
      fake,
      spec({ script: { runs: [{ events, gate: "release" }] } }),
    );
    const read = reader(adapter.records(h));
    await send(h);
    await adapter.stop(h, "graceful");
    expect((await read.run()).at(-1)).toMatchObject({
      payload: { outcome: "interrupted" },
    });
    expect(await h.exited).toMatchObject({ code: 0 });
  });

  test("graceful stop escalates to SIGTERM when the process ignores EOF", async () => {
    const stubborn = createFixtureAdapter({
      command: ["stubborn"],
      clock: expired,
    });
    const result = await stubborn.spawn(spec(), fake);
    if (!result.ok) throw new Error(result.error.message);
    await stubborn.stop(result.value, "graceful");
    expect(await result.value.exited).toMatchObject({ signal: "SIGTERM" });
  });

  test("adopt resumes the same runner session in a new process", async () => {
    const events = [{ kind: "turn_start", runner_type: "t", payload: {} }];
    const script: FixtureScriptInput = {
      runs: [
        { events },
        { events: [{ kind: "zz_second", runner_type: "t", payload: {} }] },
      ],
    };
    const first = spec({ script });
    const h1 = await spawned(fake, first);
    const read1 = reader(adapter.records(h1));
    await send(h1);
    await read1.run();
    await adapter.stop(h1, "graceful");

    const h2 = await spawned(
      fake,
      { ...first, resumeRunnerSessionId: h1.runnerSessionId },
      "adopt",
    );
    expect(h2.runnerSessionId).toBe(h1.runnerSessionId);
    expect(h2.executorRef).not.toBe(h1.executorRef);
    const read2 = reader(adapter.records(h2));
    await send(h2, "run-2");
    const run = await read2.run();
    expect(run[0]).toMatchObject({
      kind: "session_init",
      payload: { runner_session_id: h1.runnerSessionId },
    });
    expect(run[1]).toMatchObject({ kind: "runner_native", runner_type: "t" });
    await adapter.stop(h2, "kill");
  });

  test("adopt without a runner session id is a validation error", async () => {
    expect(await adapter.adopt(spec(), fake)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("crash_on_resume: adopt resolves with the session id, then the process dies before any send", async () => {
    const h = await spawned(
      fake,
      spec({
        resumeRunnerSessionId: "rs-dead",
        script: { runs: [{}], crash_on_resume: true },
      }),
      "adopt",
    );
    expect(h.runnerSessionId).toBe("rs-dead");
    expect(await h.exited).toMatchObject({ code: 137 });
    expect(await reader(adapter.records(h)).rest()).toBe(0);
  });

  test("bad input: an invalid script, a program that cannot start, an unknown handle", async () => {
    expect(
      await adapter.spawn(spec({ script: { runs: [] } }), fake),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    const missing = createFixtureAdapter({ command: ["no-such-program"] });
    expect(await missing.spawn(spec(), fake)).toMatchObject({
      ok: false,
      error: { class: "spawn_failed" },
    });
    const stranger: SessionHandle = {
      sessionId: "x",
      executorRef: "fake:0",
      exited: Promise.resolve({ stderrTail: "" }),
    };
    expect(await send(stranger)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    expect(() => adapter.records(stranger)).toThrow(
      expect.objectContaining({ class: "not_found" }),
    );
    await expect(adapter.stop(stranger, "kill")).resolves.toBeUndefined();
  });

  test("prepareHome claims the home for one session (§15 #14)", async () => {
    const s = spec();
    expect((await adapter.prepareHome(s)).ok).toBe(true);
    expect(
      await adapter.prepareHome({ ...s, sessionId: "01OTHER" }),
    ).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
  });
});

describe("the fixture adapter as a real child process", () => {
  const local = new LocalExecutor({ id: "local", slots: new SlotCounter(4) });
  // With the whole suite running in parallel a child can need well over 200 ms to read stdin EOF
  // and exit; a 200 ms grace turned that exit into a SIGTERM. Only a run that ignores
  // interrupt spends the whole grace.
  const real = createFixtureAdapter({
    graceMs: LOADED_PROCESS_BUDGETS.graceMs,
  });

  const spawnReal = async (s: SpawnSpec) => {
    const result = await real.spawn(s, local);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };

  test("runs the script and edits the worktree", async () => {
    const s = spec();
    const h = await spawnReal(s);
    expect(h.executorRef).toMatch(/^local:\d+:/);
    const read = reader(real.records(h));
    await real.send(h, { runId: "r1", text: "go", promptPath: "/p" });
    expect((await read.run()).at(-1)).toMatchObject({
      kind: "terminal",
      payload: { outcome: "ok" },
    });
    expect(readFileSync(join(s.cwd, "README.md"), "utf8")).toBe(
      "fixture was here\n",
    );
    await within(real.stop(h, "graceful"), "graceful stop");
    expect(await h.exited).toMatchObject({ code: 0 });
  });

  test("crash ends stdout with no terminal and a SIGKILL exit", async () => {
    const h = await spawnReal(spec({ script: { runs: [{ then: "crash" }] } }));
    const read = reader(real.records(h));
    await real.send(h, { runId: "r1", text: "go", promptPath: "/p" });
    expect((await read.run()).map((e) => e.kind)).toEqual(["session_init"]);
    expect(await within(h.exited, "the crash")).toMatchObject({
      signal: "SIGKILL",
    });
  });

  // The ignored interrupt spends one whole grace before stdin EOF: past vitest's 5 s default.
  test(
    "hard_hang ignores interrupt; graceful stop still ends it through stdin EOF",
    {
      timeout: 20_000,
    },
    async () => {
      const h = await spawnReal(
        spec({ script: { runs: [{ then: "hard_hang" }] } }),
      );
      const read = reader(real.records(h));
      await real.send(h, { runId: "r1", text: "go", promptPath: "/p" });
      // The run never ends on its own: stop first, then read stdout to its end.
      await within(real.stop(h, "graceful"), "graceful stop of a hard hang");
      expect(await h.exited).toMatchObject({ code: 0 });
      expect((await read.run()).map((e) => e.kind)).toEqual(["session_init"]);
    },
  );

  test("stop('kill') ends a hanging process with SIGKILL", async () => {
    const h = await spawnReal(spec({ script: { runs: [{ then: "hang" }] } }));
    await real.send(h, { runId: "r1", text: "go", promptPath: "/p" });
    await within(real.stop(h, "kill"), "kill");
    expect(await h.exited).toMatchObject({ signal: "SIGKILL" });
  });
});

describe("an MCP mount (M1 close)", () => {
  const TOKEN = "tok-mount-never-in-argv";
  const mount = {
    url: "http://127.0.0.1:3010/mcp",
    token: TOKEN,
    tools: ["ticket_get", "human_ask"],
  };

  type Started = {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };

  /** An adapter whose program records how it was started, then exits on stdin EOF. */
  function recording() {
    let record: (s: Started) => void = () => undefined;
    const started = new Promise<Started>((resolve) => {
      record = resolve;
    });
    const program = async (io: FakeIo): Promise<number> => {
      record({ argv: io.argv, env: io.env });
      for await (const chunk of io.stdin) void chunk;
      return 0;
    };
    return {
      ex: new FakeExecutor({ programs: { recording: program } }),
      started,
      adapter: createFixtureAdapter({ command: ["recording"] }),
    };
  }

  const specArg = (argv: readonly string[]): unknown =>
    JSON.parse(argv[argv.indexOf("--spec") + 1] ?? "null");

  test("the token goes into the child's env and nowhere else; the spec carries url and tools", async () => {
    const r = recording();
    const h = await r.adapter.spawn(
      spec({ env: { HOME: "/h" }, mcp: mount }),
      r.ex,
    );
    if (!h.ok) throw new Error(h.error.message);
    const started = await within(r.started, "the program start");
    expect(started.env).toEqual({
      HOME: "/h",
      [FIXTURE_MCP_TOKEN_ENV]: TOKEN,
    });
    expect(started.argv.join(" ")).not.toContain(TOKEN);
    expect(specArg(started.argv)).toMatchObject({
      mcp: { url: mount.url, tools: mount.tools },
    });
    await r.adapter.stop(h.value, "graceful");
  });

  test("without a mount the env is the spec's own and the spec names no server", async () => {
    const r = recording();
    const h = await r.adapter.spawn(spec({ env: { HOME: "/h" } }), r.ex);
    if (!h.ok) throw new Error(h.error.message);
    const started = await within(r.started, "the program start");
    expect(started.env).toEqual({ HOME: "/h" });
    expect(specArg(started.argv)).not.toHaveProperty("mcp");
    await r.adapter.stop(h.value, "graceful");
  });

  // the fixture's stand-in for the model's git runs its own floor (commitAll); what it
  // is handed is still the session's env, whole, the git floor with it.
  test("the child gets the session's git floor from spec.env, with the token beside it", async () => {
    const r = recording();
    const env = { HOME: "/h", ...SESSION_GIT_ENV };
    const h = await r.adapter.spawn(spec({ env, mcp: mount }), r.ex);
    if (!h.ok) throw new Error(h.error.message);
    const started = await within(r.started, "the program start");
    expect(started.env).toEqual({ ...env, [FIXTURE_MCP_TOKEN_ENV]: TOKEN });
    await r.adapter.stop(h.value, "graceful");
  });

  test("an empty token is refused before anything starts; the adapter is an MCP client", async () => {
    const r = recording();
    const result = await r.adapter.spawn(
      spec({ mcp: { ...mount, token: "" } }),
      r.ex,
    );
    expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(r.adapter.caps().mcpClient).toBe(true);
  });

  test("mcp_call events and a failed step's terminal map as canonical events", () => {
    const mapper = createFixtureMapper();
    const line = (o: object) => new TextEncoder().encode(JSON.stringify(o));
    const [call] = mapper.map({
      offset: 0,
      ts: 5,
      bytes: line({
        kind: "mcp_call",
        runner_type: "fixture.mcp",
        tool_name: "ticket_update",
        payload: {
          server: "foreman",
          args_digest: "a".repeat(64),
          outcome: "refused",
          reason: "cross_ticket_write",
        },
      }),
    });
    expect(call).toMatchObject({
      kind: "mcp_call",
      tool_name: "ticket_update",
      payload: { outcome: "refused", reason: "cross_ticket_write" },
    });
    const zero = {
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost_usd: 0,
    };
    const [end] = mapper.map({
      offset: 200,
      ts: 6,
      bytes: line({
        kind: "terminal",
        runner_type: "fixture.terminal",
        payload: {
          outcome: "failed",
          error: { class: "validation", message: "step 1", retryable: false },
          cumulative: { "fixture-model": zero },
        },
      }),
    });
    expect(end).toMatchObject({
      kind: "terminal",
      payload: { outcome: "failed", error: { class: "validation" } },
    });
  });
});

describe("an MCP mount on a real child process", () => {
  const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });
  const real = createFixtureAdapter({ graceMs: 200 });

  test("the program calls the server with the bearer from its env, and the run ends ok", async () => {
    const token = "tok-real-child";
    const seen: { method: string; authorization: string | undefined }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        const msg = JSON.parse(body) as { id?: number; method: string };
        seen.push({
          method: msg.method,
          authorization: req.headers.authorization,
        });
        if (msg.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        const result =
          msg.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "foreman", version: "1" },
              }
            : { content: [{ type: "text", text: '{"status":"open"}' }] };
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const started = await real.spawn(
        spec({
          script: {
            runs: [
              {
                mcp: [
                  {
                    tool: "human_ask",
                    args: {},
                    expect: { fields: { status: "open" } },
                  },
                ],
              },
            ],
          },
          mcp: {
            url: `http://127.0.0.1:${port}/mcp`,
            token,
            tools: ["human_ask"],
          },
        }),
        local,
      );
      if (!started.ok) throw new Error(started.error.message);
      const h = started.value;
      const read = reader(real.records(h));
      await real.send(h, { runId: "r1", text: "go", promptPath: "/p" });
      const events = await read.run();
      expect(events.map((e) => e.kind)).toEqual([
        "session_init",
        "mcp_call",
        "terminal",
      ]);
      expect(events.at(-1)).toMatchObject({ payload: { outcome: "ok" } });
      expect(seen.map((s) => s.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
      expect(new Set(seen.map((s) => s.authorization))).toEqual(
        new Set([`Bearer ${token}`]),
      );
      await within(real.stop(h, "graceful"), "graceful stop");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
