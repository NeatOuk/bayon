// The SDK's `spawnClaudeCodeProcess` hook must return a ChildProcess-shaped object synchronously,
// while `Executor.exec` is async (design §2). This facade stands in until the executor's process
// exists: the SDK's stdin writes are buffered in a PassThrough and flow on once attached, and each
// stdout line reaches the SDK only after the raw-log queue has it (the tee).
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { KillSignal, Proc } from "@bayon/executors";
import type { ExitInfo, RawRecord } from "../../adapter.js";

const KILL_SIGNALS: ReadonlySet<string> = new Set([
  "SIGINT",
  "SIGTERM",
  "SIGKILL",
  "SIGHUP",
]);
const NEWLINE = 0x0a;

const toKillSignal = (signal: string): KillSignal =>
  KILL_SIGNALS.has(signal) ? (signal as KillSignal) : "SIGTERM";

export class ProcFacade extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  #proc: Proc | undefined;
  #pendingSignal: KillSignal | undefined;
  #killed = false;
  #exitCode: number | null = null;
  #signalCode: NodeJS.Signals | null = null;

  get killed(): boolean {
    return this.#killed;
  }
  get exitCode(): number | null {
    return this.#exitCode;
  }
  get signalCode(): NodeJS.Signals | null {
    return this.#signalCode;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.#killed = true;
    const sig = toKillSignal(signal);
    if (this.#proc === undefined) this.#pendingSignal = sig;
    else this.#proc.kill(sig);
    return true;
  }

  /** The executor's process has started: the SDK's buffered and future stdin writes flow to it. */
  attach(proc: Proc): void {
    this.#proc = proc;
    void this.#pumpStdin(proc);
    if (this.#pendingSignal !== undefined) proc.kill(this.#pendingSignal);
  }

  async #pumpStdin(proc: Proc): Promise<void> {
    if (proc.stdin === null) return;
    try {
      for await (const chunk of this.stdin) {
        await proc.stdin.write(chunk as Uint8Array);
      }
      await proc.stdin.end();
    } catch {
      // The process stopped reading, so it is exiting; the SDK learns that from 'exit'.
      this.stdin.destroy();
    }
  }

  /** Hands one stdout line to the SDK, waiting while the SDK is behind. */
  async forward(record: RawRecord): Promise<void> {
    if (this.stdout.destroyed || this.stdout.writableEnded) return;
    const bytes = record.partial
      ? record.bytes
      : Uint8Array.of(...record.bytes, NEWLINE);
    if (!this.stdout.write(bytes)) {
      await Promise.race([
        once(this.stdout, "drain"),
        once(this.stdout, "close"),
      ]);
    }
  }

  /** The process is gone: end its stdout, then report the exit as ChildProcess does. */
  exited(info: ExitInfo): void {
    this.#exitCode = info.code ?? null;
    this.#signalCode = (info.signal ?? null) as NodeJS.Signals | null;
    this.stdout.end();
    this.emit("exit", this.#exitCode, this.#signalCode);
  }

  /** The process never started. */
  failed(error: Error): void {
    this.stdout.end();
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }
}
