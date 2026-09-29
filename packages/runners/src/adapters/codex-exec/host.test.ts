// The turn host as a real process, with toy `node -e` children standing in for
// Codex. Waits are on stdout lines and exits, each with a deadline; nothing sleeps.
//
// Each host leads its own process group, as the executor runs it, and each test ends by SIGKILLing
// that group: a host SIGKILLed alone cannot end the Codex it started, which lives on as an orphan
//. A guard then fails the test if any toy it started is still alive.
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_FILE, CONFIG_FILE, THREAD_FILE } from "./home.js";
import { HOST_FAILURE, encodeOp, hostArgv, type HostOp } from "./host.js";

const WAIT_MS = 10_000;

type Host = {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: string[];
  /** Resolves with the first line (from the start) matching `pred`. */
  line(pred: (l: string) => boolean): Promise<string>;
  send(op: HostOp): void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
};

let home = "";
let cwd = "";
let hosts: Host[] = [];
/** This test's own: every toy Codex carries it on its argv, so a survivor can be found by it. */
let marker = "";

beforeEach(() => {
  marker = `frm-host-test-${randomUUID()}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-host-")));
  home = join(root, "home");
  cwd = join(root, "work");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
});

afterEach(async () => {
  const ending = hosts;
  hosts = [];
  try {
    for (const h of ending) killGroup(h);
    await within(Promise.all(ending.map((h) => h.exited)), "the hosts' exits");
    await expectNoSurvivors();
  } finally {
    rmSync(join(home, ".."), { recursive: true, force: true });
  }
}, 3 * WAIT_MS);

/** SIGKILL to the host's whole group: the host and whatever Codex it has running. */
function killGroup(h: Host): void {
  const pid = h.proc.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Gone already, or only zombies left (macOS answers EPERM): the guard has the last word.
  }
}

/** Live processes (zombies aside) whose command line carries this test's marker. */
function survivors(): { readonly pid: number; readonly line: string }[] {
  const table = execFileSync(
    "ps",
    ["-A", "-ww", "-o", "pid=", "-o", "stat=", "-o", "command="],
    { encoding: "utf8", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } },
  );
  return table
    .split("\n")
    .filter((l) => l.includes(marker))
    .map((l) => l.trim().split(/\s+/))
    .filter(([, stat]) => stat?.startsWith("Z") !== true)
    .map(([pid, , ...command]) => ({
      pid: Number(pid),
      line: command.join(" "),
    }));
}

/**
 * Fails the test if a toy Codex outlived it. A SIGKILLed process can take a moment to leave the
 * table, so this waits for it with a deadline; one still there then is killed, so it cannot pile up.
 */
async function expectNoSurvivors(): Promise<void> {
  try {
    await vi.waitFor(() => expect(survivors()).toEqual([]), {
      timeout: WAIT_MS,
      interval: 50,
    });
  } catch (e) {
    for (const { pid } of survivors()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone meanwhile
      }
    }
    throw e;
  }
}

function within<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`timed out: ${what}`)),
        WAIT_MS,
      ).unref();
    }),
  ]);
}

function startHost(rsid = "rsid-1"): Host {
  const [node, ...args] = hostArgv(process.execPath, {
    v: 1,
    rsid,
    home,
    graceMs: 300,
  });
  const proc = spawn(node, args, {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    // Its own process group, as the executor runs it (so afterEach can end its Codex with it).
    detached: true,
  });
  const lines: string[] = [];
  let waiters: {
    pred: (l: string) => boolean;
    resolve: (l: string) => void;
  }[] = [];
  createInterface({ input: proc.stdout }).on("line", (l) => {
    lines.push(l);
    const hit = waiters.filter((w) => w.pred(l));
    waiters = waiters.filter((w) => !w.pred(l));
    for (const w of hit) w.resolve(l);
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const host: Host = {
    proc,
    lines,
    exited,
    line: (pred) => {
      const seen = lines.find(pred);
      return within(
        seen !== undefined
          ? Promise.resolve(seen)
          : new Promise((resolve) => {
              waiters.push({ pred, resolve });
            }),
        "a host line",
      );
    },
    send: (op) => proc.stdin.write(encodeOp(op)),
  };
  hosts.push(host);
  return host;
}

const typeIs = (type: string) => (l: string) => l.includes(`"type":"${type}"`);
/** A stand-in for Codex; `node -e` ignores the trailing marker, which only the guard reads. */
const toy = (source: string): string[] => [
  process.execPath,
  "-e",
  source,
  marker,
];
const turn = (
  runId: string,
  argv: readonly string[],
  extra: Partial<Extract<HostOp, { op: "turn" }>> = {},
): HostOp => ({
  op: "turn",
  run_id: runId,
  model: "gpt-5.6-luna",
  resume: false,
  argv,
  stdin: "",
  files: [],
  ...extra,
});
const USAGE = {
  input_tokens: 10,
  cached_input_tokens: 0,
  output_tokens: 2,
};

async function started(
  h: Host,
  files: HostOp & { op: "files" } = { op: "files", files: [] },
) {
  h.send(files);
  return JSON.parse(await h.line(typeIs("frm.host.start"))) as Record<
    string,
    unknown
  >;
}

describe("start", () => {
  test("the first files op is applied atomically at 0600, then the start frame", async () => {
    const h = startHost();
    const start = await started(h, {
      op: "files",
      files: [{ path: CONFIG_FILE, mode: 0o600, content: "x = 1\n" }],
    });
    expect(start).toEqual({
      type: "frm.host.start",
      v: 1,
      runner_session_id: "rsid-1",
      thread_id: null,
      usage_total: null,
    });
    const path = join(home, CONFIG_FILE);
    expect(readFileSync(path, "utf8")).toBe("x = 1\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.frm-tmp`)).toBe(false);
  });

  test("an adopting host reports the thread it finds: rsid, thread id, billed totals", async () => {
    writeFileSync(
      join(home, THREAD_FILE),
      JSON.stringify({
        rsid: "rsid-0",
        thread_id: "thr-1",
        usage_total: USAGE,
      }),
    );
    const h = startHost("rsid-0");
    expect(await started(h)).toMatchObject({
      runner_session_id: "rsid-0",
      thread_id: "thr-1",
      usage_total: USAGE,
    });
  });

  test.each([
    ["../escape", "leaves the home"],
    ["/etc/passwd", "not a home-relative path"],
    [THREAD_FILE, "thread.json is the host's own"],
  ])("a file at %j is refused: no start, exit %s", async (path, message) => {
    const h = startHost();
    let stderr = "";
    h.proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    h.send({ op: "files", files: [{ path, mode: 0o600, content: "x" }] });
    expect(await within(h.exited, "exit")).toEqual({
      code: HOST_FAILURE,
      signal: null,
    });
    expect(h.lines.some(typeIs("frm.host.start"))).toBe(false);
    expect(stderr).toContain(message);
  });

  test("the first op must be files", async () => {
    const h = startHost();
    h.send({ op: "interrupt", run_id: "run-1" });
    expect((await within(h.exited, "exit")).code).toBe(HOST_FAILURE);
  });

  test("a leftover auth.json and the log DB are removed at start; sessions and state stay", async () => {
    const codex = join(home, "codex");
    mkdirSync(join(codex, "log"), { recursive: true });
    mkdirSync(join(codex, "sessions"));
    for (const f of [
      "auth.json",
      "logs_2.sqlite",
      "logs_2.sqlite-wal",
      "state_5.sqlite",
    ])
      writeFileSync(join(codex, f), "x");
    writeFileSync(join(codex, "log", "codex.log"), "x");
    const h = startHost();
    await started(h);
    expect(existsSync(join(codex, "auth.json"))).toBe(false);
    expect(existsSync(join(codex, "logs_2.sqlite"))).toBe(false);
    expect(existsSync(join(codex, "logs_2.sqlite-wal"))).toBe(false);
    expect(existsSync(join(codex, "log"))).toBe(false);
    expect(existsSync(join(codex, "state_5.sqlite"))).toBe(true);
    expect(existsSync(join(codex, "sessions"))).toBe(true);
  });
});

describe("turns", () => {
  test("the turn frame carries Codex's argv; its stdout is relayed; the exit frame comes last", async () => {
    const h = startHost();
    await started(h);
    const argv = toy(
      'process.stdin.on("data", (d) => process.stdout.write(JSON.stringify({ type: "echo", text: String(d) }) + "\\n"))',
    );
    h.send(turn("run-1", argv, { stdin: "hello" }));
    await h.line(typeIs("frm.host.exit"));
    const [, t, echo, exit] = h.lines.map(
      (l) => JSON.parse(l) as Record<string, unknown>,
    );
    expect(t).toEqual({
      type: "frm.host.turn",
      run_id: "run-1",
      model: "gpt-5.6-luna",
      resume: false,
      argv,
    });
    expect(echo).toEqual({ type: "echo", text: "hello" });
    expect(exit).toEqual({
      type: "frm.host.exit",
      run_id: "run-1",
      code: 0,
      signal: null,
    });
  });

  test("a line cut off by the child's exit is followed by a newline before the exit frame", async () => {
    const h = startHost();
    await started(h);
    h.send(
      turn("run-1", toy('process.stdout.write("{\\"type\\":\\"partial")')),
    );
    await h.line(typeIs("frm.host.exit"));
    expect(h.lines.slice(-2)).toEqual([
      '{"type":"partial',
      '{"type":"frm.host.exit","run_id":"run-1","code":0,"signal":null}',
    ]);
  });

  test("thread.json is durable before thread.started and turn.completed are relayed", async () => {
    const h = startHost();
    await started(h);
    const lines = [
      { type: "thread.started", thread_id: "thr-9" },
      { type: "turn.completed", usage: USAGE },
    ];
    h.send(
      turn(
        "run-1",
        toy(
          `for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) process.stdout.write(l + "\\n"); setInterval(() => {}, 1 << 30);`,
        ),
      ),
    );
    await h.line(typeIs("thread.started"));
    const afterStart = JSON.parse(
      readFileSync(join(home, THREAD_FILE), "utf8"),
    );
    expect(afterStart).toMatchObject({ rsid: "rsid-1", thread_id: "thr-9" });
    await h.line(typeIs("turn.completed"));
    expect(JSON.parse(readFileSync(join(home, THREAD_FILE), "utf8"))).toEqual({
      rsid: "rsid-1",
      thread_id: "thr-9",
      usage_total: USAGE,
    });
    expect(statSync(join(home, THREAD_FILE)).mode & 0o777).toBe(0o600);
  });

  test("a turn's files (its output schema) are written before Codex starts", async () => {
    const h = startHost();
    await started(h);
    const schema = join(home, "out", "run-1.schema.json");
    h.send(
      turn(
        "run-1",
        toy(
          `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(schema)}, "utf8") + "\\n")`,
        ),
        {
          files: [
            { path: "out/run-1.schema.json", mode: 0o600, content: '{"s":1}' },
          ],
        },
      ),
    );
    await h.line(typeIs("frm.host.exit"));
    expect(h.lines).toContain('{"s":1}');
  });

  test("interrupt: the frame, then SIGINT to Codex, then the exit frame", async () => {
    const h = startHost();
    await started(h);
    h.send(
      turn(
        "run-1",
        toy(
          'process.on("SIGINT", () => process.exit(1)); console.log("{\\"type\\":\\"ready\\"}"); setInterval(() => {}, 1 << 30);',
        ),
      ),
    );
    await h.line(typeIs("ready"));
    h.send({ op: "interrupt", run_id: "run-1" });
    await h.line(typeIs("frm.host.exit"));
    expect(h.lines.slice(-2).map((l) => JSON.parse(l))).toEqual([
      { type: "frm.host.interrupt", run_id: "run-1" },
      { type: "frm.host.exit", run_id: "run-1", code: 1, signal: null },
    ]);
  });

  test("an interrupt for another run, or with no Codex running, is ignored", async () => {
    const h = startHost();
    await started(h);
    h.send({ op: "interrupt", run_id: "run-1" });
    h.send(turn("run-2", toy('console.log("{\\"type\\":\\"ok\\"}")')));
    h.send({ op: "interrupt", run_id: "run-9" });
    await h.line(typeIs("frm.host.exit"));
    expect(h.lines.some(typeIs("frm.host.interrupt"))).toBe(false);
  });

  test("a turn that finds Codex still running ends it first: one process at a time", async () => {
    const h = startHost();
    await started(h);
    h.send(
      turn(
        "run-1",
        toy(
          'console.log("{\\"type\\":\\"one\\"}"); setInterval(() => {}, 1 << 30);',
        ),
      ),
    );
    await h.line(typeIs("one"));
    h.send(turn("run-2", toy('console.log("{\\"type\\":\\"two\\"}")')));
    await h.line((l) => l.includes('"run_id":"run-2","code"'));
    const types = h.lines
      .map((l) => JSON.parse(l) as { type: string; run_id?: string })
      .map((f) => `${f.type}${f.run_id === undefined ? "" : `:${f.run_id}`}`);
    expect(types).toEqual([
      "frm.host.start",
      "frm.host.turn:run-1",
      "one",
      "frm.host.exit:run-1",
      "frm.host.turn:run-2",
      "two",
      "frm.host.exit:run-2",
    ]);
  });

  test("a program that cannot start ends its turn with status 127", async () => {
    const h = startHost();
    await started(h);
    h.send(turn("run-1", ["/nonexistent/frm-codex"]));
    expect(JSON.parse(await h.line(typeIs("frm.host.exit")))).toEqual({
      type: "frm.host.exit",
      run_id: "run-1",
      code: 127,
      signal: null,
    });
  });

  test("the log DB is reaped before each Codex process", async () => {
    const h = startHost();
    await started(h);
    const db = join(home, "codex", "logs_2.sqlite");
    mkdirSync(join(home, "codex"), { recursive: true });
    writeFileSync(db, "x");
    h.send(
      turn(
        "run-1",
        toy(
          `console.log(JSON.stringify({ type: "db", there: require("node:fs").existsSync(${JSON.stringify(db)}) }))`,
        ),
      ),
    );
    expect(JSON.parse(await h.line(typeIs("db")))).toEqual({
      type: "db",
      there: false,
    });
  });
});

describe("exits (review HIGH 1, HIGH 3)", () => {
  test("stdin EOF with no Codex: exit with the last Codex status", async () => {
    const h = startHost();
    await started(h);
    h.send(turn("run-1", toy("process.exit(3)")));
    await h.line(typeIs("frm.host.exit"));
    h.proc.stdin.end();
    expect(await within(h.exited, "exit")).toEqual({ code: 3, signal: null });
  });

  test("stdin EOF with Codex running: Codex is ended, auth.json unlinked, the host exits with Codex's status", async () => {
    const h = startHost();
    await started(h, {
      op: "files",
      files: [{ path: AUTH_FILE, mode: 0o600, content: "{}" }],
    });
    expect(existsSync(join(home, AUTH_FILE))).toBe(true);
    h.send(
      turn(
        "run-1",
        toy(
          'console.log("{\\"type\\":\\"up\\"}"); setInterval(() => {}, 1 << 30);',
        ),
      ),
    );
    await h.line(typeIs("up"));
    h.proc.stdin.end();
    expect(await within(h.exited, "exit")).toEqual({ code: 143, signal: null });
    expect(h.lines.at(-1)).toBe(
      '{"type":"frm.host.exit","run_id":"run-1","code":null,"signal":"SIGTERM"}',
    );
    expect(existsSync(join(home, AUTH_FILE))).toBe(false);
  });

  test("stdin EOF just after the turn's end: Codex exits on its own and the host exits with its status", async () => {
    const h = startHost();
    await started(h);
    h.send(
      turn(
        "run-1",
        toy(
          'console.log(JSON.stringify({ type: "turn.completed", usage: null })); setTimeout(() => process.exit(0), 100);',
        ),
      ),
    );
    await h.line(typeIs("turn.completed"));
    h.proc.stdin.end();
    expect(await within(h.exited, "exit")).toEqual({ code: 0, signal: null });
    expect(h.lines.at(-1)).toBe(
      '{"type":"frm.host.exit","run_id":"run-1","code":0,"signal":null}',
    );
  });

  test("a Codex that lingers past the grace after its turn's end is still ended: SIGTERM, 143", async () => {
    const h = startHost();
    await started(h);
    h.send(
      turn(
        "run-1",
        toy(
          'console.log(JSON.stringify({ type: "turn.failed", error: { message: "x" } })); setInterval(() => {}, 1 << 30);',
        ),
      ),
    );
    await h.line(typeIs("turn.failed"));
    h.proc.stdin.end();
    expect(await within(h.exited, "exit")).toEqual({ code: 143, signal: null });
  });

  test("SIGTERM to the host alone: it ends Codex first, and unlinks auth.json", async () => {
    const h = startHost();
    await started(h, {
      op: "files",
      files: [{ path: AUTH_FILE, mode: 0o600, content: "{}" }],
    });
    h.send(
      turn(
        "run-1",
        toy(
          'console.log(JSON.stringify({ type: "pid", pid: process.pid })); setInterval(() => {}, 1 << 30);',
        ),
      ),
    );
    const { pid } = JSON.parse(await h.line(typeIs("pid"))) as { pid: number };
    h.proc.kill("SIGTERM");
    await within(h.exited, "exit");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(home, AUTH_FILE))).toBe(false);
  });

  test("a Codex that ignores SIGTERM is SIGKILLed after the grace", async () => {
    const h = startHost();
    await started(h);
    h.send(
      turn(
        "run-1",
        toy(
          'process.on("SIGTERM", () => {}); console.log("{\\"type\\":\\"up\\"}"); setInterval(() => {}, 1 << 30);',
        ),
      ),
    );
    await h.line(typeIs("up"));
    h.proc.stdin.end();
    expect(await within(h.exited, "exit")).toEqual({ code: 137, signal: null });
  });
});
