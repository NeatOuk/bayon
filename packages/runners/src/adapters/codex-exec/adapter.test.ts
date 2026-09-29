// The adapter on its stand-in CLI, through the real turn host and the real local executor. Waits are
// on events and exits, each with a deadline; nothing sleeps.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
import {
  COMMAND_POLICY_FLAG,
  defaultCommandPolicy,
  type Result,
} from "@bayon/core";
import {
  LocalExecutor,
  SESSION_GIT_ENV,
  SlotCounter,
  type Argv,
  type ExecOpts,
  type Executor,
  type Proc,
} from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { afterEach, describe, expect, test } from "vitest";
import type {
  MappedEvent,
  RunnerAdapter,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import { createCodexExecAdapter } from "./adapter.js";
import { AUTH_FILE, CONFIG_FILE, THREAD_FILE } from "./home.js";
import { VERSION_LINE } from "./registration.js";
import { STUB_CODEX } from "./testing/stub.js";

const WAIT_MS = 15_000;
const executor = new LocalExecutor({ id: "local", slots: new SlotCounter(8) });

const PLACED_PATH = "/opt/image/bin:/usr/bin:/bin";
/** An executor that places sessions elsewhere: it records each exec, runs nothing. */
class PlacedRecorder extends FakeExecutor {
  readonly envPath = PLACED_PATH;
  readonly seen: ExecOpts[] = [];
  constructor() {
    super({ programs: {} });
  }
  override exec(_argv: Argv, opts: ExecOpts): Promise<Proc> {
    this.seen.push(opts);
    return Promise.reject(new Error("a placed executor runs nothing here"));
  }
}
const decoder = new TextDecoder();
const stub = (...extra: string[]) =>
  createCodexExecAdapter({
    bin: [process.execPath, STUB_CODEX, ...extra],
    graceMs: 300,
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

function dirs(): { cwd: string; homeDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-codex-")));
  roots.push(root);
  const cwd = join(root, "work");
  mkdirSync(cwd);
  return { cwd, homeDir: join(root, "home") };
}

function specOf(o: Partial<SpawnSpec> = {}): SpawnSpec {
  const d = dirs();
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    cwd: d.cwd,
    homeDir: d.homeDir,
    env: { PATH: process.env["PATH"] ?? "", HOME: d.homeDir },
    model: "gpt-5.6-luna",
    flags: {},
    ...o,
  };
}

type Driven = {
  readonly handle: SessionHandle;
  readonly events: MappedEvent[];
  readonly raw: string[];
  /** The first event, seen or to come, matching `pred`. */
  waitFor(pred: (e: MappedEvent) => boolean, ms?: number): Promise<MappedEvent>;
  readonly ended: Promise<void>;
};

/** Reads the handle's records through a fresh mapper, as ingest would. */
function drive(adapter: RunnerAdapter, handle: SessionHandle): Driven {
  const events: MappedEvent[] = [];
  const raw: string[] = [];
  let waiters: {
    pred: (e: MappedEvent) => boolean;
    resolve: (e: MappedEvent) => void;
  }[] = [];
  const mapper = adapter.createMapper({
    prices: adapter.registration().models,
  });
  let offset = 0;
  const ended = (async () => {
    for await (const r of adapter.records(handle)) {
      raw.push(decoder.decode(r.bytes));
      for (const e of mapper.map({ ...r, offset, ts: Date.now() })) {
        events.push(e);
        const hit = waiters.filter((w) => w.pred(e));
        waiters = waiters.filter((w) => !w.pred(e));
        for (const w of hit) w.resolve(e);
      }
      offset += r.bytes.length + 1;
    }
  })();
  live.push({ adapter, handle });
  return {
    handle,
    events,
    raw,
    ended,
    waitFor: (pred, ms) => {
      const seen = events.find(pred);
      return within(
        seen !== undefined
          ? Promise.resolve(seen)
          : new Promise((resolve) => waiters.push({ pred, resolve })),
        "an event",
        ms,
      );
    },
  };
}

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.class}: ${r.error.message}`);
  return r.value;
};

async function spawned(
  adapter: RunnerAdapter,
  spec: SpawnSpec,
  ex: Executor = executor,
): Promise<Driven> {
  unwrap(await adapter.prepareHome(spec));
  return drive(adapter, unwrap(await adapter.spawn(spec, ex)));
}

let runs = 0;
/** Sends one turn and waits for its runner terminal. */
async function turn(
  adapter: RunnerAdapter,
  d: Driven,
  text: string,
  extra: {
    readonly output?: { schema: Record<string, unknown>; path: string };
  } = {},
): Promise<MappedEvent> {
  const before = d.events.filter((e) => e.kind === "terminal").length;
  runs += 1;
  unwrap(
    await adapter.send(d.handle, {
      runId: `run-${runs}`,
      text,
      promptPath: "/dev/null",
      ...extra,
    }),
  );
  return d.waitFor(
    (e) =>
      e.kind === "terminal" &&
      d.events.filter((x) => x.kind === "terminal").indexOf(e) >= before,
  );
}

const outcome = (e: MappedEvent) =>
  e.kind === "terminal" ? e.payload.outcome : e.kind;
const stubFile = (spec: SpawnSpec, name: string): unknown =>
  JSON.parse(readFileSync(join(spec.homeDir, "codex", "stub", name), "utf8"));
const pidOf = (ref: string): number => Number(/^local:(\d+):/.exec(ref)?.[1]);

describe("turns under one handle", { timeout: 30_000 }, () => {
  test("two turns share one host: exec, then exec resume of the same thread", async () => {
    const adapter = stub();
    const spec = specOf();
    const d = await spawned(adapter, spec);
    expect(d.handle.runnerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome(await turn(adapter, d, "Reply with OK."))).toBe("ok");
    expect(outcome(await turn(adapter, d, "Reply with OK."))).toBe("ok");
    const first = stubFile(spec, "argv-0.json") as string[];
    const second = stubFile(spec, "argv-1.json") as string[];
    expect(first.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(first).toContain("-C");
    const thread = second[second.length - 2];
    expect(second.slice(0, 2)).toEqual(["exec", "resume"]);
    const inits = d.events.filter((e) => e.kind === "session_init");
    expect(
      new Set(
        inits.map(
          (e) => e.kind === "session_init" && e.payload.runner_session_id,
        ),
      ),
    ).toEqual(new Set([d.handle.runnerSessionId]));
    expect(
      inits.map((e) => e.kind === "session_init" && e.payload["thread_id"]),
    ).toEqual([thread, thread]);
    // The host alone wrote the home's files, and config.toml holds no secret.
    expect(statSync(join(spec.homeDir, CONFIG_FILE)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(join(spec.homeDir, THREAD_FILE), "utf8")),
    ).toMatchObject({
      rsid: d.handle.runnerSessionId,
      thread_id: thread,
    });
  });

  test("a second send while a run is open is a conflict", async () => {
    const adapter = stub();
    const d = await spawned(adapter, specOf());
    unwrap(
      await adapter.send(d.handle, {
        runId: "r-a",
        text: "Run the shell command `sleep 30`.",
        promptPath: "/dev/null",
      }),
    );
    expect(
      await adapter.send(d.handle, {
        runId: "r-b",
        text: "OK",
        promptPath: "/dev/null",
      }),
    ).toMatchObject({ ok: false, error: { class: "conflict" } });
  });

  test("SendSpec.output: the schema goes to the home, Codex writes the answer to the path", async () => {
    const adapter = stub();
    const spec = specOf();
    const d = await spawned(adapter, spec);
    const path = join(spec.cwd, "..", "review.json");
    await turn(adapter, d, "Review the file add.js for bugs.", {
      output: { schema: { type: "object" }, path },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      findings: [{ file: "add.js", severity: "major" }],
    });
    const argv = stubFile(spec, "argv-0.json") as string[];
    const schemaPath = argv[argv.indexOf("--output-schema") + 1] ?? "";
    expect(readFileSync(schemaPath, "utf8")).toBe('{"type":"object"}');
    expect(schemaPath.startsWith(join(spec.homeDir, "out"))).toBe(true);
  });

  test("the stub's schema review reads add.js: its planted bug is a major, the fix is clean", async () => {
    const adapter = stub();
    const spec = specOf();
    const d = await spawned(adapter, spec);
    const path = join(spec.cwd, "..", "review.json");
    const output = { schema: { type: "object" }, path };
    const addJs = join(spec.cwd, "add.js");
    writeFileSync(addJs, "export const add = (a, b) => a - b;\n");
    await turn(adapter, d, "Review the change.", { output });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      findings: [{ file: "add.js", severity: "major" }],
    });
    // The second turn is `exec resume`, whose cwd is the host's: the same worktree.
    writeFileSync(addJs, "export const add = (a, b) => a + b;\n");
    await turn(adapter, d, "Review the change.", { output });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      summary: "add() adds.",
      findings: [],
    });
  });
});

describe(
  "interrupt, crash and hang: never an inferred terminal",
  { timeout: 30_000 },
  () => {
    test("interrupt mid-tool: terminal{interrupted, basis interrupt+exit}, then the next turn resumes", async () => {
      const adapter = stub();
      const d = await spawned(adapter, specOf());
      unwrap(
        await adapter.send(d.handle, {
          runId: "r-1",
          text: "Run the shell command `sleep 30`.",
          promptPath: "/dev/null",
        }),
      );
      await d.waitFor((e) => e.kind === "tool_call");
      unwrap(await adapter.interrupt(d.handle));
      const terminal = await d.waitFor((e) => e.kind === "terminal");
      expect(terminal.kind === "terminal" && terminal.payload).toMatchObject({
        outcome: "interrupted",
        basis: "interrupt+exit",
      });
      expect(outcome(await turn(adapter, d, "Reply with OK."))).toBe("ok");
    });

    test("interrupt with no open run is a no-op", async () => {
      const adapter = stub();
      const d = await spawned(adapter, specOf());
      expect(await adapter.interrupt(d.handle)).toEqual({
        ok: true,
        value: undefined,
      });
    });

    test("Codex exiting mid-turn with no terminal ends the stream: no terminal, the host exits with Codex's status", async () => {
      const adapter = stub();
      const spec = specOf();
      const d = await spawned(adapter, {
        ...spec,
        env: { ...spec.env, FRM_STUB_CRASH: "1" },
      });
      unwrap(
        await adapter.send(d.handle, {
          runId: "r-1",
          text: "OK",
          promptPath: "/dev/null",
        }),
      );
      await within(d.ended, "the stream's end");
      expect(d.events.filter((e) => e.kind === "terminal")).toEqual([]);
      expect(await within(d.handle.exited, "the host's exit")).toMatchObject({
        code: 0,
      });
    });

    test("the known review hang: no terminal, the interrupt times out, only stop ends it", async () => {
      const adapter = stub();
      const spec = specOf();
      const d = await spawned(adapter, {
        ...spec,
        env: { ...spec.env, FRM_STUB_REVIEW_HANG: "1" },
      });
      unwrap(
        await adapter.send(d.handle, {
          runId: "r-1",
          text: "Review.",
          promptPath: "/dev/null",
        }),
      );
      await d.waitFor((e) => e.kind === "error");
      expect(await adapter.interrupt(d.handle)).toMatchObject({
        ok: false,
        error: { class: "timeout", retryable: true },
      });
      expect(await executor.probe(d.handle.executorRef)).toBe("alive");
      await adapter.stop(d.handle, "kill");
      expect(d.events.filter((e) => e.kind === "terminal")).toEqual([]);
    });

    test("a hung turn (no turn.completed) maps to no terminal while the process lives", async () => {
      const adapter = stub();
      const spec = specOf();
      const d = await spawned(adapter, {
        ...spec,
        env: { ...spec.env, FRM_STUB_HANG: "1" },
      });
      unwrap(
        await adapter.send(d.handle, {
          runId: "r-1",
          text: "Reply with OK.",
          promptPath: "/dev/null",
        }),
      );
      await d.waitFor((e) => e.kind === "assistant_text");
      expect(await executor.probe(d.handle.executorRef)).toBe("alive");
      expect(d.events.filter((e) => e.kind === "terminal")).toEqual([]);
    });
  },
);

describe("adopt (§9.6)", { timeout: 30_000 }, () => {
  test("after a stop, adopt resumes the thread from the host's start frame", async () => {
    const adapter = stub();
    const spec = specOf();
    const d = await spawned(adapter, spec);
    await turn(
      adapter,
      d,
      "Remember this word for later: lantern. Reply with OK.",
    );
    await adapter.stop(d.handle, "graceful");
    expect(await within(d.handle.exited, "exit")).toMatchObject({ code: 0 });
    const resumed = {
      ...spec,
      resumeRunnerSessionId: d.handle.runnerSessionId ?? "",
    };
    unwrap(await adapter.prepareHome(resumed));
    const a = drive(adapter, unwrap(await adapter.adopt(resumed, executor)));
    expect(a.handle.runnerSessionId).toBe(d.handle.runnerSessionId);
    await turn(adapter, a, "What was the word I asked you to remember?");
    expect(
      a.events.some((e) => e.kind === "assistant_text" && e.text === "lantern"),
    ).toBe(true);
    const argv = stubFile(spec, "argv-1.json") as string[];
    expect(argv.slice(0, 2)).toEqual(["exec", "resume"]);
  });

  test("adopting another runner session id than the home's thread is refused", async () => {
    const adapter = stub();
    const spec = specOf();
    const d = await spawned(adapter, spec);
    await turn(adapter, d, "Reply with OK.");
    await adapter.stop(d.handle, "graceful");
    expect(
      await adapter.adopt(
        { ...spec, resumeRunnerSessionId: "someone-else" },
        executor,
      ),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  });

  test("adopt without a runner session id is refused", async () => {
    expect(await stub().adopt(specOf(), executor)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("review HIGH 1: SIGKILL of the host alone leaves Codex alive; the ref probes alive until cleanup", async () => {
    const adapter = stub();
    const d = await spawned(adapter, specOf());
    unwrap(
      await adapter.send(d.handle, {
        runId: "r-1",
        text: "Run the shell command `sleep 30`.",
        promptPath: "/dev/null",
      }),
    );
    await d.waitFor((e) => e.kind === "tool_call");
    process.kill(pidOf(d.handle.executorRef), "SIGKILL");
    await within(d.handle.exited, "the host's exit");
    expect(await executor.probe(d.handle.executorRef)).toBe("alive");
    await executor.cleanup(d.handle.executorRef, "hard");
    const deadline = Date.now() + WAIT_MS;
    let state = await executor.probe(d.handle.executorRef);
    while (state === "alive" && Date.now() < deadline)
      state = await executor.probe(d.handle.executorRef);
    expect(state).toBe("dead");
  });
});

describe("command policy", { timeout: 30_000 }, () => {
  /** A linked worktree off a bare mirror: Bayon's local layout. */
  function linkedWorktree(): { worktree: string; mirror: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-codex-wt-")));
    roots.push(root);
    const env = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, env, stdio: "ignore" });
    const up = join(root, "up");
    mkdirSync(up);
    git(up, "init", "-q", "-b", "main");
    git(up, "commit", "-q", "--allow-empty", "-m", "init");
    const mirror = join(root, "mirror.git");
    git(root, "clone", "-q", "--mirror", up, mirror);
    const worktree = join(root, "wt");
    git(mirror, "worktree", "add", "-q", "-b", "agent/x", worktree, "main");
    return { worktree, mirror };
  }
  const rootsArg = (argv: readonly string[]): string | undefined =>
    argv.find((a) => a.startsWith("sandbox_workspace_write.writable_roots="));

  test("a builder in a linked worktree may write its git dirs, never the mirror's config", async () => {
    const { worktree, mirror } = linkedWorktree();
    const adapter = stub();
    const spec = specOf({
      cwd: worktree,
      flags: { [COMMAND_POLICY_FLAG]: defaultCommandPolicy("builder") },
    });
    const d = await spawned(adapter, spec);
    expect(outcome(await turn(adapter, d, "Reply with OK."))).toBe("ok");
    const argv = stubFile(spec, "argv-0.json") as string[];
    expect(rootsArg(argv)).toBe(
      `sandbox_workspace_write.writable_roots=${JSON.stringify([
        join(mirror, "worktrees", "wt"),
        join(mirror, "objects"),
        join(mirror, "refs"),
        join(mirror, "logs"),
      ])}`,
    );
  });

  test("no policy, a policy that writes no git, or a reviewer's read-only git grants no writable root", async () => {
    const { worktree } = linkedWorktree();
    for (const flags of [
      {},
      { [COMMAND_POLICY_FLAG]: { role: "x", groups: ["node"] } },
      { [COMMAND_POLICY_FLAG]: defaultCommandPolicy("reviewer") },
    ]) {
      const adapter = stub();
      const spec = specOf({ cwd: worktree, flags });
      const d = await spawned(adapter, spec);
      expect(outcome(await turn(adapter, d, "Reply with OK."))).toBe("ok");
      expect(rootsArg(stubFile(spec, "argv-0.json") as string[])).toBe(
        undefined,
      );
    }
  });

  test("a malformed policy is refused before any host starts", async () => {
    const r = await stub().spawn(
      specOf({ flags: { [COMMAND_POLICY_FLAG]: { groups: ["git_push"] } } }),
      executor,
    );
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
  });
});

// the session git floor reaches both Codex (its own git) and the model's shell (on -c).
describe("the session's git floor", { timeout: 30_000 }, () => {
  const IDENTITY = {
    GIT_AUTHOR_NAME: "Bayon Agent",
    GIT_AUTHOR_EMAIL: "agent@bayon.invalid",
    GIT_COMMITTER_NAME: "Bayon Agent",
    GIT_COMMITTER_EMAIL: "agent@bayon.invalid",
  };
  const setArg = (argv: readonly string[]): Record<string, string> => {
    const prefix = "shell_environment_policy.set=";
    const arg = argv.find((a) => a.startsWith(prefix)) ?? "";
    // The inline table is JSON's `"k":"v"` spelled with `=`: read it back the same way.
    return JSON.parse(
      arg.slice(prefix.length).replace(/"=("(?:[^"\\]|\\.)*")/g, '":$1'),
    ) as Record<string, string>;
  };

  test("Codex runs under the floor from spec.env, and every turn sets it and the identity for the shell", async () => {
    const adapter = stub();
    const spec = specOf();
    const d = await spawned(adapter, {
      ...spec,
      env: { ...spec.env, ...IDENTITY, ...SESSION_GIT_ENV },
    });
    expect(outcome(await turn(adapter, d, "Reply with OK."))).toBe("ok");
    expect(outcome(await turn(adapter, d, "Reply with OK."))).toBe("ok");
    for (const n of [0, 1]) {
      expect(stubFile(spec, `git-env-${n}.json`)).toMatchObject({
        ...SESSION_GIT_ENV,
        ...IDENTITY,
      });
      expect(setArg(stubFile(spec, `argv-${n}.json`) as string[])).toEqual({
        ...IDENTITY,
        ...SESSION_GIT_ENV,
      });
    }
  });

  test("the shell's floor does not depend on spec.env carrying it", async () => {
    const adapter = stub();
    const spec = specOf();
    const d = await spawned(adapter, spec);
    expect(outcome(await turn(adapter, d, "Reply with OK."))).toBe("ok");
    expect(setArg(stubFile(spec, "argv-0.json") as string[])).toEqual(
      SESSION_GIT_ENV,
    );
  });
});

describe("refusals", { timeout: 30_000 }, () => {
  test("a model with no priced row is refused", async () => {
    expect(
      await stub().spawn(specOf({ model: "gpt-9" }), executor),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("an empty MCP token is refused", async () => {
    expect(
      await stub().spawn(
        specOf({
          mcp: { url: "http://127.0.0.1:1/mcp", token: "", tools: [] },
        }),
        executor,
      ),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  });

  test("an MCP-only session (builtinTools none) is refused: codex-exec cannot guarantee it yet", async () => {
    const r = await stub().spawn(specOf({ builtinTools: "none" }), executor);
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(!r.ok && r.error.message).toContain("builtinTools");
  });

  test("extraRoots under workspace-write are refused, never dropped: writable_roots is unverified", async () => {
    const r = await stub().spawn(
      specOf({ extraRoots: ["/w/s/lib"] }),
      executor,
    );
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(!r.ok && r.error.message).toContain(
      "cannot grant extra roots under the workspace-write sandbox",
    );
  });

  test("danger-full-access off a container is refused", async () => {
    expect(
      await stub().spawn(
        specOf({ flags: { sandbox: "danger-full-access" } }),
        executor,
      ),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  });

  test("version drift is refused before any host starts", async () => {
    const spec = specOf();
    unwrap(await stub().prepareHome(spec));
    const r = await stub("--frm-stub-version=0.155.0").spawn(spec, executor);
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(!r.ok && r.error.message).toContain("version drift");
    expect(existsSync(join(spec.homeDir, CONFIG_FILE))).toBe(false);
  });

  test("health reports the pinned version, and drift as an error", async () => {
    expect(await stub().health(executor)).toEqual({
      ok: true,
      value: { version: VERSION_LINE },
    });
    expect(
      await stub("--frm-stub-version=0.155.0").health(executor),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("health in a placed session: its root and tmp, the executor's PATH, no host path", async () => {
    const placed = new PlacedRecorder();
    const at = { cwd: "/frm/s/S1", tmp: "/frm/s/S1/.frm/tmp" };
    expect((await stub().health(placed, at)).ok).toBe(false); // nothing runs here
    expect(placed.seen).toEqual([
      {
        cwd: at.cwd,
        env: { PATH: PLACED_PATH, HOME: at.tmp },
        stdin: "ignore",
      },
    ]);
    expect(JSON.stringify(placed.seen)).not.toContain(tmpdir());
  });
});

describe("auth (amendment g)", { timeout: 30_000 }, () => {
  const AUTH = '{"tokens":{"refresh_token":"r-1"}}';

  test("CODEX_AUTH_JSON becomes a 0600 auth.json for Codex, never its env, and is gone after stop", async () => {
    const adapter = stub();
    const spec = specOf();
    const d = await spawned(adapter, {
      ...spec,
      env: { ...spec.env, CODEX_AUTH_JSON: AUTH },
    });
    await turn(adapter, d, "Reply with OK.");
    const path = join(spec.homeDir, AUTH_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const creds = stubFile(spec, "env-0.json") as Record<string, string>;
    expect(Object.keys(creds)).toEqual(["auth.json"]);
    await adapter.stop(d.handle, "graceful");
    expect(existsSync(path)).toBe(false);
  });

  test("one live session at a time may hold auth.json", async () => {
    const adapter = stub();
    const a = specOf();
    const d = await spawned(adapter, {
      ...a,
      env: { ...a.env, CODEX_AUTH_JSON: AUTH },
    });
    const b = specOf();
    unwrap(await adapter.prepareHome(b));
    expect(
      await adapter.spawn(
        { ...b, env: { ...b.env, CODEX_AUTH_JSON: AUTH } },
        executor,
      ),
    ).toMatchObject({
      ok: false,
      error: { class: "conflict", retryable: true },
    });
    await adapter.stop(d.handle, "graceful");
    const again = await adapter.spawn(
      { ...b, env: { ...b.env, CODEX_AUTH_JSON: AUTH } },
      executor,
    );
    expect(again.ok).toBe(true);
    if (again.ok) live.push({ adapter, handle: again.value });
  });

  test("auth.json is refused off a local executor", async () => {
    const container: Executor = {
      id: "ctr",
      kind: "container",
      capabilities: { pty: false },
      prepare: (s) => executor.prepare(s),
      exec: (a, o) => executor.exec(a, o),
      pty: (a, o) => executor.pty(a, o),
      probe: (r) => executor.probe(r),
      cleanup: (r, m) => executor.cleanup(r, m),
      capacity: () => executor.capacity(),
      health: (l) => executor.health(l),
    };
    const spec = specOf();
    expect(
      await stub().spawn(
        { ...spec, env: { ...spec.env, CODEX_AUTH_JSON: AUTH } },
        container,
      ),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  });

  test("CODEX_API_KEY reaches Codex's env, never argv or the raw log", async () => {
    const adapter = stub();
    const spec = specOf();
    const key = "sk-frm-test-0123456789abcdef";
    const d = await spawned(adapter, {
      ...spec,
      env: { ...spec.env, CODEX_API_KEY: key },
    });
    await turn(adapter, d, "Reply with OK.");
    expect(Object.keys(stubFile(spec, "env-0.json") as object)).toEqual([
      "CODEX_API_KEY",
    ]);
    expect(JSON.stringify(stubFile(spec, "argv-0.json"))).not.toContain(key);
    expect(d.raw.join("\n")).not.toContain(key);
    const hostTurn = d.raw.find((l) => l.includes('"frm.host.turn"')) ?? "";
    expect(hostTurn).toContain('"exec"');
  });

  test("interactiveResume (§12.5): refused — codex exec is headless, no interactive mode", async () => {
    const adapter = stub();
    const spec = specOf();
    expect(
      await adapter.interactiveResume(spec, "some-thread-id", executor),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  });
});

describe("a login used in place (§14)", { timeout: 30_000 }, () => {
  const GRANTED =
    '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"r-1","id_token":"i-1"},"last_refresh":"2026-09-15T00:00:00Z"}';
  const ROTATED =
    '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"r-2","id_token":"i-2"},"last_refresh":"2026-09-21T00:00:00Z"}';
  /** The operator's own CLI's rotation, as long as GRANTED, so the old check would have let it go. */
  const OPERATOR_ROTATED =
    '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"r-9","id_token":"i-9"},"last_refresh":"2026-09-22T00:00:00Z"}';

  /** A granted login beside the session's dirs, 0600, as `codex login` leaves it. */
  function granted(content = GRANTED, mode = 0o600): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-granted-")));
    roots.push(dir);
    const path = join(dir, "auth.json");
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  }

  /**
   * The write-back runs on the host's exit frame — the moment Codex's process has closed — which
   * is a little after the turn's terminal. Waits for that frame rather than for a duration.
   */
  function afterCodexExit(d: Driven, seen = 0): Promise<void> {
    const exits = () =>
      d.raw.filter((l) => l.includes('"frm.host.exit"')).length;
    return within(
      new Promise<void>((resolve) => {
        const tick = () => {
          if (exits() > seen) resolve();
          else setTimeout(tick, 5).unref();
        };
        tick();
      }),
      "the host's exit frame",
    );
  }

  const withGrant = (path: string, refresh?: string): Partial<SpawnSpec> => {
    const spec = specOf();
    return {
      ...spec,
      grantedLogin: { path, value: GRANTED, mode: 0o600 },
      env:
        refresh === undefined
          ? spec.env
          : { ...spec.env, FRM_STUB_REFRESH_AUTH: refresh },
    };
  };

  test("the operator's file becomes the session's auth.json, and its rotation comes home", async () => {
    const path = granted();
    const adapter = stub();
    const spec = { ...specOf(), ...withGrant(path, ROTATED) } as SpawnSpec;
    const d = await spawned(adapter, spec);
    // What Codex was handed is the granted file, not a copy from the secret store.
    await turn(adapter, d, "Reply with OK.");
    const creds = stubFile(spec, "env-0.json") as Record<string, string>;
    expect(Object.keys(creds)).toEqual(["auth.json"]);
    // The turn rotated it: the operator's own file holds the new credential already, before stop.
    await afterCodexExit(d);
    expect(readFileSync(path, "utf8")).toBe(ROTATED);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await adapter.stop(d.handle, "graceful");
    // And the session home keeps none of it.
    expect(readFileSync(path, "utf8")).toBe(ROTATED);
    expect(existsSync(join(spec.homeDir, AUTH_FILE))).toBe(false);
  });

  test("a rotation is returned on the kill path too, where the host never unlinks", async () => {
    const path = granted();
    const adapter = stub();
    const base = { ...specOf(), ...withGrant(path, ROTATED) } as SpawnSpec;
    // Codex rotates the login as it starts, then hangs: its turn never ends, so no turn's own
    // write-back runs and only stop() can return the rotation.
    const spec = { ...base, env: { ...base.env, FRM_STUB_HANG: "1" } };
    const d = await spawned(adapter, spec);
    unwrap(
      await adapter.send(d.handle, {
        runId: "r-kill",
        text: "Reply with OK.",
        promptPath: "/dev/null",
      }),
    );
    await d.waitFor((e) => e.kind === "assistant_text");
    expect(readFileSync(join(spec.homeDir, AUTH_FILE), "utf8")).toBe(ROTATED);
    expect(readFileSync(path, "utf8")).toBe(GRANTED);
    await adapter.stop(d.handle, "kill");
    expect(readFileSync(path, "utf8")).toBe(ROTATED);
    expect(existsSync(join(spec.homeDir, AUTH_FILE))).toBe(false);
  });

  // the session was handed GRANTED and never refreshed; the operator's own CLI rotated
  // their file meanwhile. Neither the turn's write-back nor stop()'s may put GRANTED — a refresh
  // token the provider has already consumed — over it.
  test.each(["graceful", "kill"] as const)(
    "a session that rotated nothing leaves the operator's own rotation alone, at every turn and at a %s stop",
    async (mode) => {
      const path = granted();
      const adapter = stub();
      const spec = { ...specOf(), ...withGrant(path) } as SpawnSpec;
      const d = await spawned(adapter, spec);
      writeFileSync(path, OPERATOR_ROTATED, { mode: 0o600 });
      await turn(adapter, d, "Reply with OK.");
      await afterCodexExit(d);
      expect(readFileSync(path, "utf8")).toBe(OPERATOR_ROTATED);
      await adapter.stop(d.handle, mode);
      expect(readFileSync(path, "utf8")).toBe(OPERATOR_ROTATED);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  test("a truncated rotation cannot destroy a working login", async () => {
    const path = granted();
    const before = readFileSync(path);
    const adapter = stub();
    const spec = {
      ...specOf(),
      ...withGrant(path, ROTATED.slice(0, 40)),
    } as SpawnSpec;
    const d = await spawned(adapter, spec);
    await turn(adapter, d, "Reply with OK.");
    await adapter.stop(d.handle, "graceful");
    expect(readFileSync(path)).toEqual(before);
  });

  test("a turn that rotates nothing writes nothing back", async () => {
    const path = granted();
    const mtime = statSync(path, { bigint: true }).mtimeNs;
    const adapter = stub();
    const spec = { ...specOf(), ...withGrant(path) } as SpawnSpec;
    const d = await spawned(adapter, spec);
    await turn(adapter, d, "Reply with OK.");
    await adapter.stop(d.handle, "graceful");
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(mtime);
    expect(readFileSync(path, "utf8")).toBe(GRANTED);
  });

  test("without a grant nothing reads the path, even when one exists", async () => {
    // Unreadable on purpose: a spawn that touched it would fail, so the pass is the proof.
    const path = granted(GRANTED, 0o000);
    const adapter = stub();
    const spec = specOf();
    const d = await spawned(adapter, {
      ...spec,
      env: { ...spec.env, CODEX_API_KEY: "sk-frm-test-key" },
    });
    await turn(adapter, d, "Reply with OK.");
    expect(Object.keys(stubFile(spec, "env-0.json") as object)).toEqual([
      "CODEX_API_KEY",
    ]);
    expect(statSync(path).mode & 0o777).toBe(0);
  });

  test("a granted login is refused off a local executor", async () => {
    const path = granted();
    const spec = { ...specOf(), ...withGrant(path) } as SpawnSpec;
    const container: Executor = {
      id: "ctr",
      kind: "container",
      capabilities: { pty: false },
      prepare: (s) => executor.prepare(s),
      exec: (a, o) => executor.exec(a, o),
      pty: (a, o) => executor.pty(a, o),
      probe: (r) => executor.probe(r),
      cleanup: (r, m) => executor.cleanup(r, m),
      capacity: () => executor.capacity(),
      health: (l) => executor.health(l),
    };
    expect(await stub().spawn(spec, container)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("a granted login that is not a JSON object is refused before anything starts", async () => {
    const path = granted();
    const spec = {
      ...specOf(),
      grantedLogin: { path, value: "<html>502</html>", mode: 0o600 },
    } as SpawnSpec;
    const refused = await stub().spawn(spec, executor);
    expect(refused).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(JSON.stringify(refused)).toContain(path);
  });

  test("one live session at a time still holds the login", async () => {
    const path = granted();
    const adapter = stub();
    const a = { ...specOf(), ...withGrant(path) } as SpawnSpec;
    const d = await spawned(adapter, a);
    const b = { ...specOf(), ...withGrant(path) } as SpawnSpec;
    unwrap(await adapter.prepareHome(b));
    expect(await adapter.spawn(b, executor)).toMatchObject({
      ok: false,
      error: { class: "conflict", retryable: true },
    });
    await adapter.stop(d.handle, "graceful");
  });
});
