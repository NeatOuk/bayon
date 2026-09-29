// A session's raw log: the runner's stdout records, verbatim, one per line. It is the write-ahead
// log for events: a record is appended before it is mapped, replay re-reads it, and no row that
// points into it commits before its bytes are fdatasync'd (§9.4, M4 amendment).
import {
  createReadStream,
  fdatasyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const NEWLINE = 0x0a;
const NL = Buffer.from([NEWLINE]);
const PAD_CHUNK = 64 * 1024;

/** The raw log's durability call, injectable so a test can order it against the commits. */
export interface RawLogFs {
  /** fdatasync(2). On macOS Node issues F_FULLFSYNC, which also flushes the drive's cache. */
  fdatasync(fd: number): void;
}

export const nodeRawLogFs: RawLogFs = { fdatasync: fdatasyncSync };

/** A record and the offset of its first byte in the raw log. */
export interface LogRecord {
  readonly offset: number;
  readonly bytes: Uint8Array;
  /** A last line with no "\n": cut off by EOF. */
  readonly partial: boolean;
}

/** Where a new segment starts, and the raw log's length as it was found. */
export interface SegmentStart {
  readonly start: number;
  readonly found: number;
}

/**
 * Creates the raw log if needed and returns where the next process segment starts: its length, or
 * `floor` (the last committed offset) if that is further, so an offset is never reused. A torn
 * last line is ended, and a log shorter than `floor` is padded, with empty lines (which map to no
 * event). The file is fdatasync'd before the start is returned, because the caller commits it.
 */
export function prepareSegment(
  path: string,
  floor: number,
  fs: RawLogFs,
): SegmentStart {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a+", 0o600);
  try {
    const found = fstatSync(fd).size;
    const start = Math.max(found + (torn(fd, found) ? 1 : 0), floor);
    appendNewlines(fd, start - found);
    fs.fdatasync(fd);
    return { start, found };
  } finally {
    closeSync(fd);
  }
}

/** Whether a log of `size` bytes ends inside a line. */
function torn(fd: number, size: number): boolean {
  if (size === 0) return false;
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  return last[0] !== NEWLINE;
}

function appendNewlines(fd: number, count: number): void {
  const chunk = Buffer.alloc(Math.min(count, PAD_CHUNK), NEWLINE);
  for (let left = count; left > 0;) {
    left -= writeSync(fd, chunk, 0, Math.min(left, chunk.length));
  }
}

/** fdatasyncs a raw log no fd of ours holds: what a dead process wrote, before replay commits it. */
export function syncRawLog(path: string, fs: RawLogFs): void {
  const fd = openSync(path, "r");
  try {
    fs.fdatasync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Opens the raw log for appending; `size` is where the next record will start. */
export function openAppender(path: string): {
  readonly fd: number;
  readonly size: number;
} {
  const fd = openSync(path, "a", 0o600);
  return { fd, size: fstatSync(fd).size };
}

/** Appends a record and its "\n" (none after a partial one); returns the bytes written. */
export function appendRecord(
  fd: number,
  bytes: Uint8Array,
  partial: boolean,
): number {
  const line = partial ? bytes : Buffer.concat([bytes, NL]);
  for (let written = 0; written < line.length;) {
    written += writeSync(fd, line, written);
  }
  return line.length;
}

/** The records in [from, EOF), each with its offset. */
export async function* readRecords(
  path: string,
  from: number,
): AsyncGenerator<LogRecord> {
  let carry = Buffer.alloc(0);
  let offset = from;
  for await (const chunk of createReadStream(path, { start: from })) {
    const data = Buffer.concat([carry, Buffer.from(chunk)]);
    let start = 0;
    for (
      let nl = data.indexOf(NEWLINE);
      nl !== -1;
      nl = data.indexOf(NEWLINE, start)
    ) {
      yield {
        offset: offset + start,
        bytes: data.subarray(start, nl),
        partial: false,
      };
      start = nl + 1;
    }
    offset += start;
    carry = data.subarray(start);
  }
  if (carry.length > 0) yield { offset, bytes: carry, partial: true };
}
