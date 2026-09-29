// Runs the container executor's remote commands with the local shell: the test harness for
// everything but ssh itself.
import type { FrmError } from "@bayon/core";
import {
  beforeDeadline,
  startChild,
  timeoutError,
  type ProgramSpec,
  type RemoteChild,
  type Transport,
} from "./transport.js";

export class LoopbackTransport implements Transport {
  readonly #env: Readonly<Record<string, string>>;
  #rtt: number | null = null;

  /** `env` is the shell's entire environment; PATH must reach node (and a stand-in docker). */
  constructor(env: Readonly<Record<string, string>>) {
    this.#env = env;
  }

  start(command: string, signal: AbortSignal): Promise<RemoteChild> {
    if (signal.aborted) return Promise.reject(timeoutError("loopback start"));
    return beforeDeadline(
      startChild("/bin/sh", ["-c", command], this.#env),
      signal,
      "loopback start",
    );
  }

  async program(command: string, signal: AbortSignal): Promise<ProgramSpec> {
    if (signal.aborted) throw timeoutError("loopback program");
    return {
      file: "/bin/sh",
      args: ["-c", command],
      env: this.#env,
      release: () => undefined,
    };
  }

  transportError(): FrmError | null {
    return null;
  }

  observeRtt(ms: number): void {
    this.#rtt = ms;
  }

  rttMs(): number | null {
    return this.#rtt;
  }

  async close(): Promise<void> {}
}
