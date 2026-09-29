import {
  judgeExecutorHealth,
  type Clock,
  type HealthLimits,
} from "@bayon/core";
import { createChannel, type Channel } from "./channel.js";
import { frmError } from "./errors.js";
import { UNKNOWN_RELEASE } from "./retained.js";
import { SlotCounter } from "./slots.js";
import type {
  Argv,
  Capacity,
  CleanupMode,
  ExecOpts,
  Executor,
  ExecutorHealthReport,
  ExitStatus,
  KillSignal,
  PipeRelease,
  Prepared,
  PrepareSpec,
  ProbeState,
  Proc,
  ProcStdin,
  PtyOpts,
  PtyProc,
} from "./types.js";

export interface FakeWriter {
  write(chunk: string | Uint8Array): void;
}

export interface FakePty {
  readonly cols: number;
  readonly rows: number;
  onResize(listener: (cols: number, rows: number) => void): void;
}

export interface FakeIo {
  readonly argv: Argv;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: AsyncIterable<Uint8Array>;
  readonly stdout: FakeWriter;
  /** On a pty, the terminal, like stdout. */
  readonly stderr: FakeWriter;
  /** Aborted when the process is killed. Every signal is fatal to a fake program, SIGTERM and
   * SIGINT included, whereas a real program may catch those and keep running. */
  readonly signal: AbortSignal;
  /** The terminal when run by `pty()`, else null. */
  readonly pty: FakePty | null;
  /**
   * Keeps stdout and stderr open after the program returns (or is killed), as a descendant that
   * inherited them would: the exit is seen, but its streams never end until releasePipes
   *. `which` holds only one of them.
   */
  holdOutput(which?: "both" | "stdout" | "stderr"): void;
}

/** An in-memory program: resolves to its exit code. A throw exits 1 with the message on stderr. */
export type FakeProgram = (io: FakeIo) => number | Promise<number>;

export interface FakeExecutorOptions {
  /** Programs by argv[0]; any other argv[0] fails to spawn. */
  readonly programs: Readonly<Record<string, FakeProgram>>;
  readonly id?: string;
  readonly slots?: SlotCounter;
  /** The clock exitedAt reports on. Default: the system's. */
  readonly clock?: Pick<Clock, "now">;
}

interface Output {
  readonly stdout: FakeWriter;
  readonly stderr: FakeWriter;
  closeStdout(): void;
  closeStderr(): void;
}

interface Launched {
  readonly ref: string;
  readonly stdin: Channel<Uint8Array>;
  kill(signal: KillSignal): void;
  readonly exited: Promise<ExitStatus>;
}

/** What a finished program still holds open, until releasePipes ends it. */
interface Held {
  readonly exitedAt: number;
  readonly close: () => void;
}

const encoder = new TextEncoder();
const bytes = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? encoder.encode(chunk) : chunk;

/** An in-memory Executor for tests: programs are functions, refs are `fake:<n>`. */
export class FakeExecutor implements Executor {
  readonly kind = "local";
  readonly capabilities = { pty: true } as const;
  readonly id: string;
  readonly #programs: ReadonlyMap<string, FakeProgram>;
  readonly #slots: SlotCounter;
  readonly #clock: Pick<Clock, "now">;
  readonly #running = new Map<string, (signal: KillSignal) => void>();
  /** Programs that exited while a stream stayed held (holdOutput). */
  readonly #held = new Map<string, Held>();
  /** When each program exited, while its streams may still be read. */
  readonly #exitedAt = new Map<string, number>();
  #spawned = 0;

  constructor(options: FakeExecutorOptions) {
    this.id = options.id ?? "fake";
    this.#programs = new Map(Object.entries(options.programs));
    this.#slots = options.slots ?? new SlotCounter(4);
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  async prepare(spec: PrepareSpec): Promise<Prepared> {
    return { root: spec.root };
  }

  async exec(argv: Argv, opts: ExecOpts): Promise<Proc> {
    const stdout = createChannel<Uint8Array>();
    const stderr = createChannel<Uint8Array>();
    const output: Output = {
      stdout: { write: (chunk) => stdout.push(bytes(chunk)) },
      stderr: { write: (chunk) => stderr.push(bytes(chunk)) },
      closeStdout: () => stdout.close(),
      closeStderr: () => stderr.close(),
    };
    const proc = this.#launch(argv, opts, output, null);
    if (opts.stdin === "ignore") proc.stdin.close();
    return {
      ref: proc.ref,
      stdin: opts.stdin === "ignore" ? null : stdinOf(proc.stdin),
      stdout,
      stderr,
      kill: (signal = "SIGTERM") => proc.kill(signal),
      exited: proc.exited,
    };
  }

  async pty(argv: Argv, opts: PtyOpts): Promise<PtyProc> {
    const output = createChannel<string>();
    if (!this.#programs.has(argv[0])) {
      // node-pty resolves even when the child can't start, reporting the failure through the
      // pty's own exit code instead of rejecting (see the `Executor.pty` docstring); match that
      // here rather than the `spawn_failed` rejection exec() uses for the same case.
      output.close();
      this.#spawned += 1;
      return {
        ref: `fake:${this.#spawned}`,
        output,
        write: () => {},
        resize: () => {},
        kill: () => {},
        exited: Promise.resolve({ code: 1, signal: null }),
      };
    }
    const decoder = new TextDecoder();
    const terminal: FakeWriter = {
      write: (chunk) =>
        output.push(
          typeof chunk === "string"
            ? chunk
            : decoder.decode(chunk, { stream: true }),
        ),
    };
    let size = { cols: opts.cols, rows: opts.rows };
    const listeners: ((cols: number, rows: number) => void)[] = [];
    const pty: FakePty = {
      get cols() {
        return size.cols;
      },
      get rows() {
        return size.rows;
      },
      onResize: (listener) => void listeners.push(listener),
    };
    const closeTerminal = () => output.close();
    const proc = this.#launch(
      argv,
      opts,
      {
        stdout: terminal,
        stderr: terminal,
        closeStdout: closeTerminal,
        closeStderr: closeTerminal,
      },
      pty,
    );
    return {
      ref: proc.ref,
      output,
      write: (data) => proc.stdin.push(encoder.encode(data)),
      resize: (cols, rows) => {
        size = { cols, rows };
        for (const listener of listeners) listener(cols, rows);
      },
      kill: (signal = "SIGTERM") => proc.kill(signal),
      exited: proc.exited,
    };
  }

  async probe(ref: string): Promise<ProbeState> {
    assertFakeRef(ref);
    return this.#running.has(ref) ? "alive" : "dead";
  }

  async cleanup(ref: string, mode: CleanupMode): Promise<void> {
    assertFakeRef(ref);
    this.#running.get(ref)?.(mode === "hard" ? "SIGKILL" : "SIGTERM");
  }

  exitedAt(ref: string): number | null {
    return this.#exitedAt.get(ref) ?? null;
  }

  /** Ends what a finished program held open (holdOutput); a fake reader is never behind. */
  releasePipes(ref: string): PipeRelease {
    const held = this.#held.get(ref);
    if (held === undefined) {
      return this.#exitedAt.has(ref)
        ? { state: "released", pendingBytes: 0 }
        : UNKNOWN_RELEASE;
    }
    this.#held.delete(ref);
    held.close();
    return { state: "released", pendingBytes: 0 };
  }

  capacity(): Capacity {
    return this.#slots.capacity();
  }

  /** Healthy, measuring nothing: the fake has no disk and runs on the supervisor's clock. */
  async health(limits: HealthLimits): Promise<ExecutorHealthReport> {
    return judgeExecutorHealth({
      checkedAt: Date.now(),
      disk: [],
      clockSkewMs: 0,
      limits,
    });
  }

  #launch(
    argv: Argv,
    opts: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    },
    output: Output,
    pty: FakePty | null,
  ): Launched {
    if (opts.signal?.aborted === true) {
      throw frmError("interrupted", "exec aborted before spawn");
    }
    const program = this.#programs.get(argv[0]);
    if (program === undefined)
      throw frmError("spawn_failed", `no fake program ${argv[0]}`);

    this.#spawned += 1;
    const ref = `fake:${this.#spawned}`;
    const stdin = createChannel<Uint8Array>();
    const killed = new AbortController();
    const { promise: exited, resolve } = Promise.withResolvers<ExitStatus>();
    let hold: "none" | "both" | "stdout" | "stderr" = "none";
    const finish = (status: ExitStatus) => {
      if (!this.#running.delete(ref)) return;
      stdin.close();
      const exitedAt = this.#clock.now();
      this.#exitedAt.set(ref, exitedAt);
      if (hold !== "stdout" && hold !== "both") output.closeStdout();
      if (hold !== "stderr" && hold !== "both") output.closeStderr();
      if (hold !== "none") {
        this.#held.set(ref, {
          exitedAt,
          close: () => {
            output.closeStdout();
            output.closeStderr();
          },
        });
      }
      resolve(status);
    };
    const kill = (signal: KillSignal) => {
      finish({ code: null, signal });
      killed.abort();
    };
    this.#running.set(ref, kill);

    const onAbort = () => kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    void exited.then(() => opts.signal?.removeEventListener("abort", onAbort));

    const io: FakeIo = {
      argv,
      cwd: opts.cwd,
      env: opts.env,
      stdin,
      stdout: output.stdout,
      stderr: output.stderr,
      signal: killed.signal,
      pty,
      holdOutput: (which = "both") => {
        hold = which;
      },
    };
    void Promise.resolve()
      .then(() => program(io))
      .then(
        (code) => finish({ code, signal: null }),
        (err: unknown) => {
          output.stderr.write(
            `${err instanceof Error ? err.message : String(err)}\n`,
          );
          finish({ code: 1, signal: null });
        },
      );
    return { ref, stdin, kill, exited };
  }
}

function stdinOf(stdin: Channel<Uint8Array>): ProcStdin {
  return {
    write: async (chunk) => {
      if (stdin.closed) throw frmError("internal", "stdin is closed");
      stdin.push(bytes(chunk));
    },
    end: async () => stdin.close(),
  };
}

function assertFakeRef(ref: string): void {
  if (!/^fake:\d+$/.test(ref)) {
    throw frmError(
      "validation",
      `not a fake executor ref: ${JSON.stringify(ref)}`,
    );
  }
}
