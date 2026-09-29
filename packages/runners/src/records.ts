// A runner's stdout as records: split into lines, queued for the one consumer (supervisor ingest,
// which writes them to the raw log). Runner-neutral; every adapter tees its stdout through here.
import type { RawRecord } from "./adapter.js";
import { frmError } from "./errors.js";

/** Bytes a queue holds before `push` waits for the reader. Nothing is ever dropped. */
export const RECORDS_HIGH_WATER = 8 * 1024 * 1024;

const NEWLINE = 0x0a;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Splits byte chunks into lines without their "\n". A fragment cut off by EOF is `partial`. */
export async function* splitLines(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<RawRecord> {
  let carry = new Uint8Array(0);
  for await (const chunk of chunks) {
    const data = concat(carry, chunk);
    let start = 0;
    for (
      let nl = data.indexOf(NEWLINE);
      nl !== -1;
      nl = data.indexOf(NEWLINE, start)
    ) {
      yield { bytes: data.slice(start, nl), partial: false };
      start = nl + 1;
    }
    carry = data.slice(start);
  }
  if (carry.length > 0) yield { bytes: carry, partial: true };
}

/** A byte-bounded, single-consumer queue of records. */
export interface RecordQueue extends AsyncIterable<RawRecord> {
  /** Queues a record; resolves once the queue is back at or below its high-water mark. */
  push(record: RawRecord): Promise<void>;
  /** Ends iteration once the queued records are drained. Later pushes are ignored. */
  close(): void;
}

export function createRecordQueue(highWater = RECORDS_HIGH_WATER): RecordQueue {
  // Channel internals: mutable, but never exposed.
  const queued: RawRecord[] = [];
  let size = 0;
  let closed = false;
  let consumed = false;
  let wakeReader: (() => void) | undefined;
  let writers: (() => void)[] = [];

  const notifyReader = () => {
    const wake = wakeReader;
    wakeReader = undefined;
    wake?.();
  };
  const releaseWriters = () => {
    if (size > highWater) return;
    const waiting = writers;
    writers = [];
    for (const resume of waiting) resume();
  };

  async function* drain(): AsyncGenerator<RawRecord> {
    for (;;) {
      const next = queued.shift();
      if (next !== undefined) {
        size -= next.bytes.length;
        releaseWriters();
        yield next;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wakeReader = resolve;
      });
    }
  }

  return {
    push(record) {
      if (closed) return Promise.resolve();
      queued.push(record);
      size += record.bytes.length;
      notifyReader();
      if (size <= highWater) return Promise.resolve();
      return new Promise<void>((resolve) => {
        writers.push(resolve);
      });
    },
    close() {
      closed = true;
      notifyReader();
    },
    [Symbol.asyncIterator]() {
      if (consumed) {
        throw frmError("conflict", "a runner's records have one consumer");
      }
      consumed = true;
      return drain();
    },
  };
}
