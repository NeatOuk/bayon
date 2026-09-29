import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { Writable } from "node:stream";
import type { Clock, HealthLimits } from "@bayon/core";
import { frmError } from "../errors.js";
import {
  UNKNOWN_RELEASE,
  releaseRetained,
  retain,
  type PipeControl,
} from "../retained.js";
import type { SlotCounter } from "../slots.js";
import type {
  Argv,
  Capacity,
  CleanupMode,
  ExecOpts,
  Executor,
  ExecutorHealthReport,
  ExitStatus,
  Owned,
  PipeRelease,
  Prepared,
  PrepareSpec,
  ProbeState,
  Proc,
  ProcStdin,
  PtyOpts,
  PtyProc,
} from "../types.js";
import { localHealth, type DiskPaths } from "./health.js";
import {
  groupAlive,
  mintRef,
  parseRef,
  readProc,
  signalTree,
} from "./proc-info.js";
import { listTaggedProcs, SESSION_ID_ENV } from "./proc-scan.js";
import { spawnPty } from "./pty.js";

export interface LocalExecutorOptions {
  readonly id: string;
  /** Shared with admission, which holds one slot per session (§9.1). */
  readonly slots: SlotCounter;
  /**
   * The FRM_HOME_TAG its supervisor stamps into every session's environment: listOwned finds that
   * supervisor's processes by it. Without one, listOwned lists nothing.
   */
  readonly homeTag?: string;
  /** The paths health() measures free disk on (the supervisor's FRM_HOME/work and the repos'
   * mirrors), asked on each check. Default: none, so no disk is reported. */
  readonly diskPaths?: DiskPaths;
  /** The clock exitedAt reports on: the supervisor's. Default: the system's. */
  readonly clock?: Pick<Clock, "now">;
}

const SYSTEM_NOW: Pick<Clock, "now"> = { now: () => Date.now() };

/** The bare-metal executor: child processes on this host (§6). Refs are `local:<pid>:<start>`. */
export class LocalExecutor implements Executor {
  readonly kind = "local";
  readonly capabilities = { pty: true } as const;
  readonly id: string;
  readonly #slots: SlotCounter;
  readonly #homeTag: string | undefined;
  readonly #diskPaths: DiskPaths;
  readonly #clock: Pick<Clock, "now">;
  /** Each exec'd process's streams, until both have closed. */
  readonly #pipes = new Map<string, PipeControl>();

  constructor(options: LocalExecutorOptions) {
    this.id = options.id;
    this.#slots = options.slots;
    this.#homeTag = options.homeTag;
    this.#diskPaths = options.diskPaths ?? (() => []);
    this.#clock = options.clock ?? SYSTEM_NOW;
  }

  async prepare(spec: PrepareSpec): Promise<Prepared> {
    // The root will hold the runner home and its session token: operator-only.
    await mkdir(spec.root, { recursive: true, mode: 0o700 });
    return { root: spec.root };
  }

  async exec(argv: Argv, opts: ExecOpts): Promise<Proc> {
    // A call, so the post-spawn re-check is not narrowed away: the signal may abort mid-spawn.
    const isAborted = () => opts.signal?.aborted === true;
    if (isAborted()) {
      throw frmError("interrupted", "exec aborted before spawn");
    }
    const [file, ...args] = argv;
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...opts.env },
      detached: opts.detached ?? true,
      stdio: [opts.stdin ?? "pipe", "pipe", "pipe"],
    });
    // The child's own exit, which a descendant holding its pipes does not delay.
    let exitedAt: number | null = null;
    const exited = new Promise<ExitStatus>((resolve) =>
      child.once("exit", (code, signal) => {
        exitedAt = this.#clock.now();
        resolve({ code, signal });
      }),
    );
    await started(child, file);
    const { pid, stdin, stdout, stderr } = child;
    if (pid === undefined || stdout === null || stderr === null) {
      throw frmError("internal", `spawned ${file} without a pid or pipes`);
    }
    const out = retain(stdout);
    const err = retain(stderr);
    const kill: Proc["kill"] = (signal = "SIGTERM") => {
      // Node sets these when it reaps the child; from then on the pid may be someone else's.
      if (child.exitCode === null && child.signalCode === null) {
        signalTree(pid, signal);
      }
    };
    const onAbort = () => kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted()) onAbort();
    void exited.then(() => opts.signal?.removeEventListener("abort", onAbort));
    const pipe = stdin === null ? null : stdinOf(stdin);
    const ref = await mintRef(pid);
    const control: PipeControl = {
      exitedAt: () => exitedAt,
      release: (force) => releaseRetained([out, err], exitedAt !== null, force),
      closed: Promise.all([out.closed, err.closed]).then(() => undefined),
    };
    this.#pipes.set(ref, control);
    void control.closed.then(() => this.#pipes.delete(ref));
    return {
      ref,
      stdin: pipe,
      stdout: out.kept,
      stderr: err.kept,
      kill,
      exited,
    };
  }

  pty(argv: Argv, opts: PtyOpts): Promise<PtyProc> {
    return spawnPty(argv, opts);
  }

  /** Free disk on `diskPaths` and the clock, which is the supervisor's own (§6.1). */
  health(limits: HealthLimits): Promise<ExecutorHealthReport> {
    return localHealth({ paths: this.#diskPaths, limits, now: Date.now });
  }

  /**
   * Alive while the process lives, or, once it is gone, while any process of the group it led
   * does: a runner whose leader died alone must not look dead while its child still works
   * (Invariant 12; the reconciler kills before it adopts). A live pid with another start time is a
   * reused pid, and a pgid is never reused while its group has members, so that group is gone.
   */
  async probe(ref: string): Promise<ProbeState> {
    const { pid, start } = parseRef(ref);
    const info = await readProc(pid);
    if (info !== null && !info.zombie) {
      return info.start === start ? "alive" : "dead";
    }
    return (await groupAlive(pid)) ? "alive" : "dead";
  }

  async cleanup(ref: string, mode: CleanupMode): Promise<void> {
    const { pid } = parseRef(ref);
    if ((await this.probe(ref)) === "alive") {
      signalTree(pid, mode === "hard" ? "SIGKILL" : "SIGTERM");
    }
  }

  exitedAt(ref: string): number | null {
    return this.#pipes.get(ref)?.exitedAt() ?? null;
  }

  releasePipes(ref: string, o: { readonly force?: boolean } = {}): PipeRelease {
    return this.#pipes.get(ref)?.release(o.force === true) ?? UNKNOWN_RELEASE;
  }

  /**
   * Every process of this uid whose environment carries both of this supervisor's tags (design
   *): its ref pins the pid's start time, so `cleanup` re-checks it before a signal.
   * Never this process, its group or its ancestors; never a session id it inherited itself.
   */
  async listOwned(): Promise<readonly Owned[]> {
    if (this.#homeTag === undefined) return [];
    const inherited = process.env[SESSION_ID_ENV];
    const found = await listTaggedProcs({
      homeTag: this.#homeTag,
      ...(inherited === undefined ? {} : { inheritedSessionId: inherited }),
    });
    return found.map((p) => ({
      kind: "process" as const,
      sessionId: p.sessionId,
      ref: `local:${p.pid}:${p.start}`,
      homeTag: p.homeTag,
    }));
  }

  capacity(): Capacity {
    return this.#slots.capacity();
  }
}

function started(child: ChildProcess, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      child.off("spawn", onSpawn);
      reject(
        frmError("spawn_failed", `cannot start ${file}: ${err.message}`, {
          cause: err,
        }),
      );
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

function stdinOf(stdin: Writable): ProcStdin {
  // A write after the child exits fails with EPIPE. That reaches the caller as write()'s
  // rejection; this listener only stops the same error from crashing the supervisor.
  stdin.on("error", () => {});
  return {
    write: (chunk) =>
      new Promise((resolve, reject) => {
        stdin.write(chunk, (err) =>
          err
            ? reject(frmError("internal", "stdin write failed", { cause: err }))
            : resolve(),
        );
      }),
    end: () =>
      new Promise((resolve) => {
        stdin.end(() => resolve());
      }),
  };
}
