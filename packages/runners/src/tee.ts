// Reads a runner process's output for its adapter. Runner-neutral.
import type { Proc } from "@bayon/executors";
import type { ExitInfo, RawRecord } from "./adapter.js";
import { createRecordQueue, splitLines, type RecordQueue } from "./records.js";

/** Bytes of stderr kept for `ExitInfo.stderrTail`. */
export const STDERR_TAIL_BYTES = 16 * 1024;

export type Teed = {
  /** The stdout records, for their one consumer. */
  readonly records: RecordQueue;
  /** Settles once the process has exited and its stderr is drained. Never rejects. */
  readonly exited: Promise<ExitInfo>;
  /** Settles once stdout has ended and every line was queued and forwarded. Never rejects. */
  readonly drained: Promise<void>;
};

async function readTail(
  stream: AsyncIterable<Uint8Array>,
  max: number,
): Promise<string> {
  let tail = new Uint8Array(0);
  let note = "";
  try {
    for await (const chunk of stream) {
      const joined = new Uint8Array(tail.length + chunk.length);
      joined.set(tail, 0);
      joined.set(chunk, tail.length);
      tail = joined.length > max ? joined.slice(joined.length - max) : joined;
    }
  } catch (e) {
    note = `\n[frm: stderr read failed: ${String(e)}]`;
  }
  return new TextDecoder().decode(tail) + note;
}

/**
 * Each stdout line goes first to `records` (the raw log is the write-ahead log for events), then
 * to `forward`. Reading pauses while `records` is over its high-water mark: nothing is dropped.
 */
export function tee(
  proc: Proc,
  options: {
    /**
     * Sees each line before the queue does, so state it drives is current for any reader. A
     * returned promise holds that line (and every later one) back until it settles: what the line
     * announces is then already done when a reader has it. It must not reject.
     */
    readonly observe?: (record: RawRecord) => Promise<void> | void;
    readonly forward?: (record: RawRecord) => Promise<void> | void;
    readonly highWater?: number;
  } = {},
): Teed {
  const records = createRecordQueue(options.highWater);
  let readError: string | undefined;
  const drained = (async () => {
    try {
      for await (const record of splitLines(proc.stdout)) {
        const held = options.observe?.(record);
        if (held !== undefined) await held;
        await records.push(record);
        await options.forward?.(record);
      }
    } catch (e) {
      readError = String(e);
    } finally {
      records.close();
    }
  })();
  const stderr = readTail(proc.stderr, STDERR_TAIL_BYTES);
  const exited = Promise.all([proc.exited, stderr]).then(
    ([status, tail]): ExitInfo => ({
      ...(status.code === null ? {} : { code: status.code }),
      ...(status.signal === null ? {} : { signal: status.signal }),
      stderrTail:
        readError === undefined
          ? tail
          : `${tail}\n[frm: stdout read failed: ${readError}]`,
    }),
  );
  return { records, exited, drained };
}
