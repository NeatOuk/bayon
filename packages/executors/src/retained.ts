import { PassThrough, type Readable } from "node:stream";
import type { PipeRelease } from "./types.js";

// A child's output, retained from spawn. Once the child exits, Node discards
// output nobody is consuming yet, so each stream is piped into a PassThrough at once (backpressure
// intact), and a stream error reaches whoever reads it instead of crashing the supervisor.
//
// `pipe`, never `stream.pipeline`: a released source must detach from its PassThrough first.
// Destroying a pipeline's source destroys its PassThrough with a premature-close error, which the
// reader would see (tee would note it in stderrTail). release() unpipes, ends the PassThrough, so
// its reader reads what is left and then EOF, and only then destroys the source.

export interface Retained {
  /** What the reader consumes. */
  readonly kept: PassThrough;
  /** Bytes buffered and not yet read: in the source, and in the PassThrough. */
  pending(): number;
  /** The reader is behind: bytes are buffered, or the source is paused on backpressure. */
  draining(): boolean;
  /** Detaches the source, ends the PassThrough and destroys the source. Idempotent. */
  release(): void;
  /** Settles once the PassThrough has closed: nothing more comes, and nothing waits. */
  readonly closed: Promise<void>;
}

export function retain(source: Readable): Retained {
  const kept = new PassThrough();
  let released = false;
  // Its reader's iteration still rejects on an error; this only keeps an error nobody listens for
  // yet from crashing the supervisor.
  kept.on("error", () => undefined);
  source.on("error", (err) => {
    if (!released) kept.destroy(err);
  });
  source.pipe(kept);
  const closed = new Promise<void>((resolve) => {
    kept.once("close", () => resolve());
  });
  return {
    kept,
    pending: () => kept.readableLength + source.readableLength,
    draining: () =>
      kept.readableLength > 0 ||
      source.readableLength > 0 ||
      (!source.destroyed && source.isPaused()),
    release() {
      if (released) return;
      released = true;
      source.unpipe(kept);
      kept.end();
      source.destroy();
    },
    closed,
  };
}

/** What an executor keeps per process for Executor.exitedAt and releasePipes. */
export interface PipeControl {
  /** When the child's own exit was seen, on the executor's clock; null while it runs. */
  exitedAt(): number | null;
  release(force: boolean): PipeRelease;
  /** Settles once nothing more can come from the process's streams: the entry can go. */
  readonly closed: Promise<void>;
}

/** releasePipes over retained streams: unknown before the exit, draining while a reader is behind. */
export function releaseRetained(
  streams: readonly Retained[],
  exited: boolean,
  force: boolean,
): PipeRelease {
  const pendingBytes = streams.reduce((n, s) => n + s.pending(), 0);
  if (!exited) return { state: "unknown", pendingBytes };
  if (!force && streams.some((s) => s.draining())) {
    return { state: "draining", pendingBytes };
  }
  for (const s of streams) s.release();
  return { state: "released", pendingBytes };
}

export const UNKNOWN_RELEASE: PipeRelease = {
  state: "unknown",
  pendingBytes: 0,
};
