// One program on the remote side, through the exec-shim: the hello, stdin
// under a credit window, kill in-band with a `ctl` fallback, the liveness watchdog and the exit.
import { PassThrough, type Readable } from "node:stream";
import type { FrmError } from "@bayon/core";
import { frmError } from "../errors.js";
import { retain, type PipeControl, type Retained } from "../retained.js";
import type {
  Argv,
  ExitStatus,
  KillSignal,
  PipeRelease,
  Proc,
  ProcStdin,
} from "../types.js";
import {
  encodeFrame,
  encodeJson,
  FrameDecoder,
  FrameType,
  payloadJson,
  type Frame,
} from "./frames.js";
import {
  beforeDeadline,
  type RemoteChild,
  type RemoteExit,
} from "./transport.js";

export interface ExecutorDiagnostic {
  /** `oom`: the container's OOM killer took the program. `lost`: its channel died before its
   * exit frame. `kill_fallback_failed`: an out-of-band signal could not be sent either.
   * `image_unreadable`: the configured image's id could not be read — the one
   * thing a container certification pins, so a read that fails silently is a certification that
   * pins nothing. `ref` is the image the read was for. */
  readonly kind: "oom" | "lost" | "kill_fallback_failed" | "image_unreadable";
  readonly ref: string;
  readonly detail: string;
}

export interface RemoteProcOptions {
  readonly ref: string;
  readonly child: RemoteChild;
  readonly argv: Argv;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: "pipe" | "ignore";
  readonly windowBytes: number;
  readonly heartbeatMs: number;
  readonly deadmanMs: number;
  readonly killGraceMs: number;
  /** Ends the wait for the started (or failed) frame. */
  readonly startSignal: AbortSignal;
  /** `ExecOpts.signal`: aborting kills with SIGKILL. */
  readonly abort?: AbortSignal;
  /** Signals the program out of band, on a fresh channel; bounded by the callee. */
  readonly ctl: (signal: KillSignal) => Promise<void>;
  readonly transportError: (
    exit: RemoteExit,
    stderr: string,
  ) => FrmError | null;
  readonly onDiagnostic: (d: ExecutorDiagnostic) => void;
  /** The clock exitedAt reports on. Default: the system's. */
  readonly now?: () => number;
}

/** Each started program's pipe control, for the executor's exitedAt and releasePipes. */
const CONTROLS = new WeakMap<Proc, PipeControl>();

/** The pipe control of a Proc startRemoteProc returned. */
export const pipesOf = (proc: Proc): PipeControl | undefined =>
  CONTROLS.get(proc);

interface Waiter {
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (err: FrmError) => void;
}

/** The status reported when the program's exit frame never came: the shim's dead-man (or a
 * fallback `ctl KILL`) ends its group. */
const LOST: ExitStatus = { code: null, signal: "SIGKILL" };
const STDERR_GRACE_MS = 2_000;

/** Resolves once the program has started; a program that cannot start is `spawn_failed`. */
export async function startRemoteProc(o: RemoteProcOptions): Promise<Proc> {
  const proc = new RemoteProc(o);
  try {
    await beforeDeadline(proc.started, o.startSignal, `starting ${o.argv[0]}`);
  } catch (err) {
    o.child.kill();
    throw err;
  }
  const handle = proc.handle();
  CONTROLS.set(handle, proc.pipes());
  return handle;
}

class RemoteProc {
  readonly started: Promise<void>;
  readonly exited: Promise<ExitStatus>;
  readonly #o: RemoteProcOptions;
  readonly #stdoutKept: Retained;
  readonly #stdout: PassThrough;
  readonly #stderr = new PassThrough();
  /** When the exit frame came: the program's own exit. */
  #exitedAt: number | null = null;
  /** releasePipes ended stderr: later stderr frames are dropped. */
  #stderrReleased = false;
  readonly #decoder = new FrameDecoder();
  readonly #waiters: Waiter[] = [];
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #start: {
    readonly resolve: () => void;
    readonly reject: (err: FrmError) => void;
  };
  #credit: number;
  #lastHeard = Date.now();
  #status: ExitStatus | null = null;
  #pendingKill: KillSignal | null = null;
  #began = false;
  #done = false;

  constructor(o: RemoteProcOptions) {
    this.#o = o;
    this.#credit = o.windowBytes;
    let resolve = (): void => undefined;
    let reject: (err: FrmError) => void = () => undefined;
    const started: Promise<void> = new Promise((res, rej) => {
      resolve = () => res();
      reject = rej;
    });
    this.started = started;
    this.#start = { resolve, reject };
    // Awaited by startRemoteProc; a rejection after it gave up is not a crash.
    this.started.catch(() => undefined);
    this.#stdoutKept = retain(o.child.stdout);
    this.#stdout = this.#stdoutKept.kept;
    o.child.stderr.on("data", (chunk: Buffer) => this.#heard(chunk));
    this.#send(
      encodeJson(FrameType.hello, {
        v: 1,
        argv: o.argv,
        cwd: o.cwd,
        env: o.env,
        stdin: o.stdin,
        killGraceMs: o.killGraceMs,
        deadmanMs: o.deadmanMs,
        heartbeatMs: o.heartbeatMs,
      }),
    );
    this.#every(o.heartbeatMs, () => this.#send(encodeFrame(FrameType.ping)));
    this.#every(o.heartbeatMs, () => this.#watch());
    const onAbort = () => this.kill("SIGKILL");
    o.abort?.addEventListener("abort", onAbort, { once: true });
    if (o.abort?.aborted === true) onAbort();
    this.exited = this.#settle().finally(() =>
      o.abort?.removeEventListener("abort", onAbort),
    );
  }

  handle(): Proc {
    return {
      ref: this.#o.ref,
      stdin: this.#stdinHandle(),
      stdout: this.#stdout,
      stderr: this.#stderr,
      kill: (signal) => this.kill(signal),
      exited: this.exited,
    };
  }

  /**
   * exitedAt and releasePipes. Once the exit frame came, a release ends stdout
   * (detached first, so its reader reads what is left) and stderr, and closes the channel, so the
   * handle settles with the status the exit frame carried. Draining while a reader is behind.
   */
  pipes(): PipeControl {
    return {
      exitedAt: () => this.#exitedAt,
      release: (force) => this.#release(force),
      closed: Promise.all([this.exited, this.#stdoutKept.closed]).then(
        () => undefined,
      ),
    };
  }

  #release(force: boolean): PipeRelease {
    const pendingBytes =
      this.#stdoutKept.pending() + this.#stderr.readableLength;
    if (this.#exitedAt === null) return { state: "unknown", pendingBytes };
    const behind =
      this.#stdoutKept.draining() || this.#stderr.readableLength > 0;
    if (behind && !force) return { state: "draining", pendingBytes };
    this.#stdoutKept.release();
    if (!this.#stderrReleased) {
      this.#stderrReleased = true;
      this.#stderr.end();
    }
    this.#o.child.kill();
    return { state: "released", pendingBytes };
  }

  kill(signal: KillSignal = "SIGTERM"): void {
    if (this.#done || this.#status !== null) return;
    if (!this.#began) {
      // The shim has no group to signal yet: send it once the program starts.
      this.#pendingKill = signal;
      return;
    }
    if (!this.#send(encodeFrame(FrameType.kill, signal))) {
      // Queued behind a full pipe, or the channel is gone: say it again on a fresh channel.
      void this.#o.ctl(signal).catch((err: unknown) =>
        this.#o.onDiagnostic({
          kind: "kill_fallback_failed",
          ref: this.#o.ref,
          detail: describe(err),
        }),
      );
    }
    if (signal === "SIGKILL") {
      // No exit frame in time: close our end; the shim's dead-man finishes the group.
      const timer = setTimeout(() => {
        if (!this.#done && this.#status === null) this.#o.child.kill();
      }, this.#o.killGraceMs);
      timer.unref();
      this.#timers.push(timer);
    }
  }

  #stdinHandle(): ProcStdin | null {
    if (this.#o.stdin === "ignore") return null;
    const window = this.#o.windowBytes;
    return {
      write: async (chunk) => {
        const bytes =
          typeof chunk === "string"
            ? Buffer.from(chunk, "utf8")
            : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (let at = 0; at < bytes.length; at += window) {
          const piece = bytes.subarray(at, at + window);
          await this.#take(piece.length);
          await this.#write(encodeFrame(FrameType.data, piece));
        }
      },
      end: async () => {
        await this.#write(encodeFrame(FrameType.eof)).catch(() => undefined);
      },
    };
  }

  /** Waits for `bytes` of credit: the shim acks what reached the program's stdin. */
  #take(bytes: number): Promise<void> {
    if (this.#done) return Promise.reject(closed());
    if (this.#waiters.length === 0 && this.#credit >= bytes) {
      this.#credit -= bytes;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) =>
      this.#waiters.push({ bytes, resolve, reject }),
    );
  }

  #grant(): void {
    for (;;) {
      const next = this.#waiters[0];
      if (next === undefined || this.#credit < next.bytes) return;
      this.#waiters.shift();
      this.#credit -= next.bytes;
      next.resolve();
    }
  }

  #write(frame: Buffer): Promise<void> {
    const stdin = this.#o.child.stdin;
    if (this.#done || !stdin.writable) return Promise.reject(closed());
    return new Promise((resolve, reject) => {
      stdin.write(frame, (err) =>
        err
          ? reject(frmError("internal", "stdin write failed", { cause: err }))
          : resolve(),
      );
    });
  }

  /** A control frame: never behind data beyond the credit window. False if it had to queue. */
  #send(frame: Buffer): boolean {
    const stdin = this.#o.child.stdin;
    if (this.#done || !stdin.writable) return false;
    return stdin.write(frame);
  }

  #heard(chunk: Buffer): void {
    this.#lastHeard = Date.now();
    try {
      for (const frame of this.#decoder.push(chunk)) this.#onFrame(frame);
    } catch (err) {
      this.#o.onDiagnostic({
        kind: "lost",
        ref: this.#o.ref,
        detail: describe(err),
      });
      this.#o.child.kill();
    }
  }

  #onFrame(frame: Frame): void {
    switch (frame.type) {
      case FrameType.started: {
        this.#began = true;
        this.#start.resolve();
        const pending = this.#pendingKill;
        this.#pendingKill = null;
        if (pending !== null) this.kill(pending);
        return;
      }
      case FrameType.failed: {
        const message = field(payloadJson(frame), "message") ?? "unknown";
        this.#start.reject(
          frmError(
            "spawn_failed",
            `cannot start ${this.#o.argv[0]}: ${message}`,
          ),
        );
        return;
      }
      case FrameType.ack: {
        const bytes = Number(field(payloadJson(frame), "bytes") ?? 0);
        this.#credit += Number.isFinite(bytes) ? bytes : 0;
        this.#grant();
        return;
      }
      case FrameType.stderr:
        if (this.#stderrReleased) return;
        if (!this.#stderr.write(frame.payload)) {
          this.#o.child.stderr.pause();
          this.#stderr.once("drain", () => this.#o.child.stderr.resume());
        }
        return;
      case FrameType.exit:
        this.#exitedAt = (this.#o.now ?? Date.now)();
        this.#status = exitStatusOf(payloadJson(frame), (oom) => {
          if (oom) {
            this.#o.onDiagnostic({
              kind: "oom",
              ref: this.#o.ref,
              detail: "the container's OOM killer ended the program",
            });
          }
        });
        return;
      default:
        return; // tick: being heard is all it says
    }
  }

  /** Our end is not reading (a consumer that stopped draining) or the channel is silent. */
  #watch(): void {
    if (this.#done) return;
    const paused = [this.#stdout, this.#stderr].some(
      (s) => s.readableLength >= s.readableHighWaterMark,
    );
    if (paused) {
      this.#lastHeard = Date.now();
      return;
    }
    if (Date.now() - this.#lastHeard <= this.#o.deadmanMs) return;
    this.#o.onDiagnostic({
      kind: "lost",
      ref: this.#o.ref,
      detail: `no frame for ${this.#o.deadmanMs} ms: closing the channel`,
    });
    this.#o.child.kill();
  }

  #every(ms: number, fn: () => void): void {
    const timer = setInterval(fn, ms);
    timer.unref();
    this.#timers.push(timer);
  }

  async #settle(): Promise<ExitStatus> {
    const exit = await this.#o.child.exited;
    await ended(this.#o.child.stderr, STDERR_GRACE_MS);
    this.#done = true;
    for (const timer of this.#timers) clearTimeout(timer);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(closed());
    if (!this.#stderrReleased) {
      this.#stderrReleased = true;
      this.#stderr.end();
    }
    if (!this.#began) {
      const diagnostic = this.#decoder.diagnostic;
      this.#start.reject(
        this.#o.transportError(exit, diagnostic) ??
          frmError(
            "spawn_failed",
            `cannot start ${this.#o.argv[0]}: ${diagnostic || `the remote side exited ${exit.code ?? exit.signal}`}`,
          ),
      );
      return { code: 127, signal: null };
    }
    if (this.#status !== null) return this.#status;
    this.#o.onDiagnostic({
      kind: "lost",
      ref: this.#o.ref,
      detail:
        this.#decoder.diagnostic ||
        `the channel closed (${exit.code ?? exit.signal}) before the exit frame`,
    });
    await this.#o.ctl("SIGKILL").catch(() => undefined);
    return LOST;
  }
}

function exitStatusOf(
  value: unknown,
  onOom: (oom: boolean) => void,
): ExitStatus {
  const code = field(value, "code");
  const signal = field(value, "signal");
  onOom(field(value, "oom") === true);
  if (typeof code === "number" && signal === null) return { code, signal };
  if (code === null && typeof signal === "string") return { code, signal };
  return LOST;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const closed = (): FrmError =>
  frmError("internal", "stdin is closed: the program has exited");

function describe(err: unknown): string {
  return typeof err === "object" && err !== null && "message" in err
    ? String(err.message)
    : String(err);
}

function ended(stream: Readable, ms: number): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    stream.once("end", done);
    stream.once("close", done);
  });
}
