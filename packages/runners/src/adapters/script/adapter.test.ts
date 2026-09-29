// Conformance-shaped tests for the generic `script` adapter (§15): #9 (interrupt/hang), #10 (an
// unknown event kind survives as `runner_native`), #14 (home claiming) are non-negotiable per
// CLAUDE.md. The adapter has no built-in program (Invariant 1 keeps job logic out of this package),
// so tests drive it against a minimal in-process test double built from `io.ts`'s own helpers --
// exactly what a real job script (export-markdown.ts) does, just smaller.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "@bayon/core";
import type { Executor } from "@bayon/executors";
import { FakeExecutor, type FakeIo } from "@bayon/executors/testing";
import { afterAll, describe, expect, test } from "vitest";
import type {
  MappedEvent,
  RawRecord,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import { createScriptAdapter } from "./adapter.js";
import { emit, readGo, readOps } from "./io.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-script-adapter-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const dir = (name: string) => join(root, `${name}-${++dirs}`);

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

const expired: Clock = { now: () => 0, after: async () => undefined };

type TestScript = {
  readonly events?: readonly Record<string, unknown>[];
  readonly then?: "terminal" | "hang";
};

/** A minimal test double speaking the same protocol a real job script does: wait for `send`, emit
 * a fixed sequence, honor `interrupt`, exit only on stdin EOF. */
function testJob(script: TestScript): (io: FakeIo) => Promise<number> {
  return async (io) => {
    const ops = readOps(io.stdin);
    const go = await readGo(ops);
    if (go !== undefined) {
      emit(io, {
        kind: "session_init",
        runner_type: "test.init",
        payload: { runner_session_id: "rs-1" },
      });
      for (const e of script.events ?? []) emit(io, e);
      if ((script.then ?? "terminal") === "terminal") {
        emit(io, {
          kind: "terminal",
          runner_type: "test.terminal",
          payload: { outcome: "ok" },
        });
      } else {
        // hang: silent until interrupted, exactly like §15 #9.
        for (;;) {
          const next = await ops.next();
          if (next.done === true) return 0;
          if (next.value.op === "interrupt") {
            emit(io, {
              kind: "terminal",
              runner_type: "test.terminal",
              payload: { outcome: "interrupted" },
            });
            break;
          }
        }
      }
    }
    // Exits only on stdin EOF, never self-terminates after `terminal`.
    for (;;) {
      const next = await ops.next();
      if (next.done === true) return 0;
    }
  };
}

const JOB = "test-job";
const fake = new FakeExecutor({
  programs: {
    [JOB]: testJob({
      events: [
        { kind: "turn_start", runner_type: "t", payload: {} },
        { kind: "zz_unknown", runner_type: "t.unknown", payload: {} },
      ],
    }),
    hangJob: testJob({
      events: [{ kind: "turn_start", runner_type: "t", payload: {} }],
      then: "hang",
    }),
    // Never exits on EOF; dies on any signal (FakeExecutor: every signal is fatal to a fake program).
    stubborn: (io) =>
      new Promise<number>((resolve) =>
        io.signal.addEventListener("abort", () => resolve(0)),
      ),
  },
});

const adapter = createScriptAdapter({ id: "script-test", argv: [JOB] });

function spec(
  overrides: Partial<SpawnSpec> & { argv?: readonly string[] } = {},
): SpawnSpec {
  const { argv, ...rest } = overrides;
  const cwd = dir("cwd");
  const homeDir = dir("home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return {
    sessionId: "01SESSION",
    cwd,
    homeDir,
    env: {},
    model: "script",
    flags: argv === undefined ? { argv: [JOB] } : { argv },
    ...rest,
  };
}

function reader(records: AsyncIterable<RawRecord>) {
  const iterator = records[Symbol.asyncIterator]();
  const mapper = adapter.createMapper({ prices: [] });
  let offset = 0;
  return {
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
  };
}

async function spawned(ex: Executor, s: SpawnSpec): Promise<SessionHandle> {
  const result = await adapter.spawn(s, ex);
  if (!result.ok) throw new Error(`spawn failed: ${result.error.message}`);
  return result.value;
}

const send = (h: SessionHandle, runId = "run-1") =>
  adapter.send(h, { runId, text: "go", promptPath: "/prompts/run.md" });

describe("the generic script adapter", () => {
  test("registers one runner row per instance, kind job (not an agent), not resumable, not billed", () => {
    const reg = adapter.registration();
    expect(reg.runner).toMatchObject({
      id: "script-test",
      kind: "job",
      adapter: "script-test",
      versionDetected: "1",
      defaults: { argv: [JOB] },
    });
    expect(reg.models).toEqual([
      expect.objectContaining({
        id: "script-test.cheap",
        priceInPerMtok: 0,
        contextTokens: 0,
      }),
    ]);
    expect(adapter.caps()).toMatchObject({
      structuredEvents: true,
      multiTurnInProcess: false,
      resumable: false,
      costReporting: false,
      mcpClient: false,
    });
  });

  test("spawn execs flags.argv; run maps to the emitted sequence, unknown kind kept (§15 #10)", async () => {
    const h = await spawned(fake, spec());
    const read = reader(adapter.records(h));
    expect((await send(h)).ok).toBe(true);
    const run = await read.run();
    expect(run.map((e) => e.kind)).toEqual([
      "session_init",
      "turn_start",
      "runner_native",
      "terminal",
    ]);
    expect(run[2]?.runner_type).toBe("t.unknown");
    expect(run.at(-1)?.payload).toMatchObject({ outcome: "ok" });
    await adapter.stop(h, "graceful");
    expect(await h.exited).toEqual({ code: 0, stderrTail: "" });
  });

  test("a hang goes silent until interrupted, then ends with outcome interrupted (§15 #9)", async () => {
    const h = await spawned(fake, spec({ argv: ["hangJob"] }));
    const read = reader(adapter.records(h));
    await send(h);
    expect((await adapter.interrupt(h)).ok).toBe(true);
    expect((await read.run()).at(-1)).toMatchObject({
      kind: "terminal",
      payload: { outcome: "interrupted" },
    });
    await adapter.stop(h, "graceful");
    expect(await h.exited).toMatchObject({ code: 0 });
  });

  test("a send while a run is open is a conflict", async () => {
    const h = await spawned(fake, spec({ argv: ["hangJob"] }));
    await send(h);
    expect(await send(h, "run-x")).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
    await adapter.stop(h, "kill");
  });

  test("graceful stop interrupts the open run before closing stdin", async () => {
    const h = await spawned(fake, spec({ argv: ["hangJob"] }));
    const read = reader(adapter.records(h));
    await send(h);
    await adapter.stop(h, "graceful");
    expect((await read.run()).at(-1)).toMatchObject({
      payload: { outcome: "interrupted" },
    });
    expect(await h.exited).toMatchObject({ code: 0 });
  });

  test("graceful stop escalates to SIGTERM when the process ignores EOF", async () => {
    const stubborn = createScriptAdapter({
      id: "script-stubborn",
      argv: ["stubborn"],
      clock: expired,
    });
    const result = await stubborn.spawn(spec({ argv: ["stubborn"] }), fake);
    if (!result.ok) throw new Error(result.error.message);
    await stubborn.stop(result.value, "graceful");
    expect(await result.value.exited).toMatchObject({ signal: "SIGTERM" });
  });

  test("stop('kill') ends a hanging process with SIGKILL", async () => {
    const h = await spawned(fake, spec({ argv: ["hangJob"] }));
    await send(h);
    await adapter.stop(h, "kill");
    expect(await h.exited).toMatchObject({ signal: "SIGKILL" });
  });

  test("adopt always refuses: the script runner is not resumable", async () => {
    expect(await adapter.adopt(spec(), fake)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("bad input: missing argv, a program that cannot start, an unknown handle", async () => {
    expect(await adapter.spawn(spec({ argv: [] }), fake)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    const missing = createScriptAdapter({
      id: "script-missing",
      argv: ["no-such-program"],
    });
    expect(
      await missing.spawn(spec({ argv: ["no-such-program"] }), fake),
    ).toMatchObject({
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

  test("estimateTokens approximates from text length", async () => {
    expect(await adapter.estimateTokens("abcd")).toBe(2);
  });
});
