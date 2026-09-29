import {
  fdatasyncSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  prepareSegment,
  readRecords,
  syncRawLog,
  type RawLogFs,
} from "./raw-log.js";

const dir = mkdtempSync("/tmp/frm-raw-log-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let logs = 0;
/** A raw-log path under a directory that does not exist yet; `content` writes the log first. */
function logPath(content?: string): string {
  logs += 1;
  const path = join(dir, `s${logs}`, "logs", "stdout.jsonl");
  if (content !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return path;
}

/** The real fdatasync, recording the file's length at each call: what that call made durable. */
function recordingFs() {
  const synced: number[] = [];
  const fs: RawLogFs = {
    fdatasync(fd) {
      fdatasyncSync(fd);
      synced.push(fstatSync(fd).size);
    },
  };
  return { fs, synced };
}

const LINE = '{"a":1}\n'; // 8 bytes
const TORN = `${LINE}{"b`; // 11 bytes, no final "\n"

test.each([
  // [case, content, floor, start, content after]
  ["a new log", undefined, 0, 0, ""],
  ["a log ending in a newline", LINE, 0, 8, LINE],
  ["a torn last line is ended", TORN, 0, 12, `${TORN}\n`],
  ["a floor inside the log changes nothing", LINE + LINE, 5, 16, LINE + LINE],
  ["a log shorter than the floor", LINE, 12, 12, `${LINE}\n\n\n\n`],
  ["a torn log shorter than the floor", TORN, 14, 14, `${TORN}\n\n\n`],
  ["a missing log below the floor", undefined, 5, 5, "\n".repeat(5)],
  [
    "a pad longer than one write",
    undefined,
    200_000,
    200_000,
    "\n".repeat(200_000),
  ],
] as const)("prepareSegment: %s", (_, content, floor, start, after) => {
  const path = logPath(content);
  const { fs, synced } = recordingFs();
  const found = content === undefined ? 0 : Buffer.byteLength(content);
  expect(prepareSegment(path, floor, fs)).toEqual({ start, found });
  expect(readFileSync(path, "utf8")).toBe(after);
  // One fdatasync, after every write: it covered the start the caller then commits.
  expect(synced).toEqual([start]);
});

test("padding reads back as empty records, which every mapper maps to no event", async () => {
  const path = logPath(TORN);
  const { start } = prepareSegment(path, 16, recordingFs().fs);
  const records = [];
  for await (const r of readRecords(path, 8)) records.push(r);
  expect(
    records.map((r) => [r.offset, Buffer.from(r.bytes).toString()]),
  ).toEqual([
    [8, '{"b'],
    [12, ""],
    [13, ""],
    [14, ""],
    [15, ""],
  ]);
  expect(start).toBe(16);
});

test("prepareSegment surfaces a failed fdatasync; the caller commits no start", () => {
  const path = logPath(LINE);
  const failing: RawLogFs = {
    fdatasync() {
      throw new Error("EIO: injected");
    },
  };
  expect(() => prepareSegment(path, 0, failing)).toThrow("EIO: injected");
});

test("syncRawLog fdatasyncs a log it did not write; a missing log throws", () => {
  const path = logPath(LINE + LINE);
  const { fs, synced } = recordingFs();
  syncRawLog(path, fs);
  expect(synced).toEqual([16]);
  expect(() => syncRawLog(join(dir, "missing.jsonl"), fs)).toThrow(/ENOENT/);
});
