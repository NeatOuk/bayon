// The behaviour every Executor must share, run against each implementation (local, the fake, and
// the container executor). Internal to this package: it imports vitest.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  ExecutorHealthDetail,
  lowestFreePct,
  type HealthLimits,
} from "@bayon/core";
import type { SlotCounter } from "./slots.js";
import type { Argv, ExecOpts, Executor, Proc, PtyProc } from "./types.js";

/** What each program must do, as argv for the executor under test. */
export interface ContractPrograms {
  /** Copies stdin to stdout until EOF, then exits 0. */
  readonly cat: Argv;
  /** Writes `1` to stdout, `2` to stderr, `3` to stdout, `4` to stderr, one line each, reading
   * one stdin line after every write; then exits 0. */
  readonly interleave: Argv;
  /** Prints its cwd, `$FOO`, and `$HOME` (`-` when unset), one per line. */
  readonly whereami: Argv;
  /** Exits 3. */
  readonly exit3: Argv;
  /** Runs until signalled. */
  readonly forever: Argv;
  /** Names nothing that can start. */
  readonly missing: Argv;
  /** In a pty: prints `size <cols>x<rows>` at start and after every resize; echoes input. */
  readonly ptyEcho: Argv;
}

export interface ContractSubject {
  readonly executor: Executor;
  /** The counter the executor was built with, sized 2. */
  readonly slots: SlotCounter;
  readonly programs: ContractPrograms;
}

/** Where an executor that does not run on this machine's filesystem keeps its test files. */
export interface ContractHooks {
  /** A fresh directory the executor's programs may use as cwd. Default: a local temp dir. */
  readonly workdir?: () => Promise<string>;
  readonly removeWorkdir?: (dir: string) => Promise<void>;
  /** The root `prepare` is given for a session. Default: `<workdir>/sessions/<id>`. */
  readonly sessionRoot?: (workdir: string, sessionId: string) => string;
}

const DEADLINE_MS = 5_000;
/** A health check is bounded by its executor (a container's `timeouts.health_ms`, 30 s). */
const HEALTH_DEADLINE_MS = 60_000;
/** The fleet's limits as the contract hands them over: a floor no real disk fails. */
const HEALTH_LIMITS: HealthLimits = { clockSkewMaxMs: 5_000, minFreePct: 0 };

/** Rejects unless `promise` settles before the deadline. Real processes run on real time. */
export async function within<T>(
  promise: Promise<T>,
  what: string,
  ms = DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline passed: ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readAll(
  stream: AsyncIterable<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream)
    text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/** Returns a function that reads the pty until `text` has appeared in its output. */
function screen(pty: PtyProc): (text: string) => Promise<void> {
  const output = pty.output[Symbol.asyncIterator]();
  let seen = "";
  return async (text) => {
    while (!seen.includes(text)) {
      const next = await within(output.next(), `pty output ${text}`);
      if (next.done === true) {
        throw new Error(
          `pty closed before ${text}; saw ${JSON.stringify(seen)}`,
        );
      }
      seen += next.value;
    }
  };
}

export function describeExecutorContract(
  name: string,
  make: () => ContractSubject,
  hooks: ContractHooks = {},
): void {
  describe(`Executor contract: ${name}`, { timeout: 15_000 }, () => {
    let dir = "";
    let subject: ContractSubject;
    const running = new Set<Proc | PtyProc>();

    const track = <P extends Proc | PtyProc>(proc: P): P => {
      running.add(proc);
      void proc.exited.then(() => running.delete(proc));
      return proc;
    };
    const exec = async (argv: Argv, opts: Partial<ExecOpts> = {}) =>
      track(await subject.executor.exec(argv, { cwd: dir, env: {}, ...opts }));
    /** Without a pty, `pty()` is refused with `validation` and the test ends there. */
    const noPty = async (): Promise<boolean> => {
      if (subject.executor.capabilities.pty) return false;
      await expect(
        subject.executor.pty(subject.programs.ptyEcho, {
          cwd: dir,
          env: {},
          cols: 80,
          rows: 24,
        }),
      ).rejects.toMatchObject({ class: "validation" });
      return true;
    };

    beforeAll(async () => {
      dir =
        hooks.workdir === undefined
          ? await realpath(await mkdtemp(join(tmpdir(), "frm-executor-")))
          : await hooks.workdir();
    });
    afterAll(() =>
      hooks.removeWorkdir === undefined
        ? rm(dir, { recursive: true, force: true })
        : hooks.removeWorkdir(dir),
    );
    beforeEach(() => {
      subject = make();
    });
    afterEach(async () => {
      const left = [...running];
      for (const proc of left) proc.kill("SIGKILL");
      await within(Promise.all(left.map((proc) => proc.exited)), "reaping");
    });

    test("prepare yields a root exec can use as cwd; env is exactly what was given", async () => {
      const prepared = await subject.executor.prepare({
        sessionId: "ses-1",
        root:
          hooks.sessionRoot?.(dir, "ses-1") ?? join(dir, "sessions", "ses-1"),
      });
      const proc = await exec(subject.programs.whereami, {
        cwd: prepared.root,
        env: { FOO: "bar" },
      });
      const [out, status] = await within(
        Promise.all([readAll(proc.stdout), proc.exited]),
        "whereami",
      );
      expect(out).toBe(`${prepared.root}\nbar\n-\n`);
      expect(status).toEqual({ code: 0, signal: null });
    });

    test("streams stdout and stderr live, each in order", async () => {
      const proc = await exec(subject.programs.interleave);
      const stdin = proc.stdin;
      if (stdin === null) throw new Error("expected a stdin pipe");
      const log: string[] = [];
      const pump = async (label: string, stream: AsyncIterable<Uint8Array>) => {
        for await (const chunk of stream) {
          for (const line of new TextDecoder().decode(chunk).split("\n")) {
            if (line === "") continue;
            log.push(`${label}:${line}`);
            await stdin.write("ack\n");
          }
        }
      };
      await within(
        Promise.all([
          pump("out", proc.stdout),
          pump("err", proc.stderr),
          proc.exited,
        ]),
        "interleave",
      );
      expect(log).toEqual(["out:1", "err:2", "out:3", "err:4"]);
    });

    test("pipes stdin through to the program", async () => {
      const proc = await exec(subject.programs.cat);
      await proc.stdin?.write("hello ");
      await proc.stdin?.write(new TextEncoder().encode("world"));
      await proc.stdin?.end();
      expect(await within(readAll(proc.stdout), "cat")).toBe("hello world");
      expect(await within(proc.exited, "cat exit")).toEqual({
        code: 0,
        signal: null,
      });
    });

    test("stdin 'ignore' gives no handle and the program EOF", async () => {
      const proc = await exec(subject.programs.cat, { stdin: "ignore" });
      expect(proc.stdin).toBeNull();
      expect(await within(readAll(proc.stdout), "cat")).toBe("");
      expect(await within(proc.exited, "cat exit")).toEqual({
        code: 0,
        signal: null,
      });
    });

    test("reports the exit code", async () => {
      const proc = await exec(subject.programs.exit3);
      expect(await within(proc.exited, "exit3")).toEqual({
        code: 3,
        signal: null,
      });
    });

    test("output survives until it is read, even after the program exits", async () => {
      const proc = await exec(subject.programs.whereami, {
        env: { FOO: "late" },
      });
      await within(proc.exited, "whereami exit");
      expect(await within(readAll(proc.stdout), "late read")).toBe(
        `${dir}\nlate\n-\n`,
      );
    });

    test.each(["SIGTERM", "SIGINT", "SIGKILL"] as const)(
      "kill(%s) reports that signal",
      async (signal) => {
        const proc = await exec(subject.programs.forever);
        proc.kill(signal);
        expect(await within(proc.exited, signal)).toEqual({
          code: null,
          signal,
        });
      },
    );

    test("kill() defaults to SIGTERM", async () => {
      const proc = await exec(subject.programs.forever);
      proc.kill();
      expect(await within(proc.exited, "kill")).toEqual({
        code: null,
        signal: "SIGTERM",
      });
    });

    test("aborting the signal kills with SIGKILL", async () => {
      const abort = new AbortController();
      const proc = await exec(subject.programs.forever, {
        signal: abort.signal,
      });
      abort.abort();
      expect(await within(proc.exited, "abort")).toEqual({
        code: null,
        signal: "SIGKILL",
      });
    });

    test("an already-aborted signal refuses to spawn", async () => {
      await expect(
        exec(subject.programs.forever, { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ class: "interrupted" });
    });

    test("a program that cannot start is spawn_failed", async () => {
      await expect(exec(subject.programs.missing)).rejects.toMatchObject({
        class: "spawn_failed",
      });
    });

    test("probe: alive while running, dead after exit", async () => {
      const proc = await exec(subject.programs.forever);
      expect(await subject.executor.probe(proc.ref)).toBe("alive");
      proc.kill();
      await within(proc.exited, "kill");
      expect(await subject.executor.probe(proc.ref)).toBe("dead");
    });

    test.each([
      ["soft", "SIGTERM"],
      ["hard", "SIGKILL"],
    ] as const)(
      "cleanup(%s) sends %s; a dead ref is a no-op",
      async (mode, signal) => {
        const proc = await exec(subject.programs.forever);
        await subject.executor.cleanup(proc.ref, mode);
        expect(await within(proc.exited, "cleanup")).toEqual({
          code: null,
          signal,
        });
        await subject.executor.cleanup(proc.ref, mode);
        expect(await subject.executor.probe(proc.ref)).toBe("dead");
      },
    );

    test("capacity reports the injected slot counter", async () => {
      expect(subject.executor.capacity()).toEqual({ slots: 2, used: 0 });
      const slot = subject.slots.tryAcquire();
      expect(subject.executor.capacity()).toEqual({ slots: 2, used: 1 });
      slot?.release();
      expect(subject.executor.capacity()).toEqual({ slots: 2, used: 0 });
    });

    test(
      "health reports the uniform detail under the limits it is given, and never rejects",
      async () => {
        const report = await within(
          subject.executor.health(HEALTH_LIMITS),
          "health",
          HEALTH_DEADLINE_MS,
        );
        const detail = ExecutorHealthDetail.parse(report.detail);
        expect(report.healthy).toBe(detail.failures.length === 0);
        // An executor's own limits may only tighten the fleet's.
        expect(detail.min_free_pct).toBeGreaterThanOrEqual(
          HEALTH_LIMITS.minFreePct,
        );
        expect(detail.clock_skew_max_ms).toBeLessThanOrEqual(
          HEALTH_LIMITS.clockSkewMaxMs,
        );
        expect(detail.free_pct).toBe(lowestFreePct(detail.disk));
      },
      HEALTH_DEADLINE_MS + 5_000,
    );

    test("pty echoes input, reports resizes, and is probed and killed like exec", async () => {
      if (await noPty()) return;
      const pty = track(
        await subject.executor.pty(subject.programs.ptyEcho, {
          cwd: dir,
          env: {},
          cols: 80,
          rows: 24,
        }),
      );
      const waitFor = screen(pty);
      await waitFor("size 80x24");
      pty.write("hello\r");
      await waitFor("hello");
      pty.resize(100, 40);
      await waitFor("size 100x40");
      expect(await subject.executor.probe(pty.ref)).toBe("alive");
      pty.kill();
      expect(await within(pty.exited, "pty kill")).toEqual({
        code: null,
        signal: "SIGTERM",
      });
      expect(await subject.executor.probe(pty.ref)).toBe("dead");
    });

    test("pty: a program that cannot start resolves and exits with code 1, unlike exec", async () => {
      if (await noPty()) return;
      const pty = track(
        await subject.executor.pty(subject.programs.missing, {
          cwd: dir,
          env: {},
          cols: 80,
          rows: 24,
        }),
      );
      expect(await within(pty.exited, "pty on a missing program")).toEqual({
        code: 1,
        signal: null,
      });
    });
  });
}
