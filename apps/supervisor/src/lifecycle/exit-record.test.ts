// The exit record beside a raw log: header, redaction, the file's cap.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { REDACTED } from "../ingest/redact.js";
import {
  appendExitRecord,
  renderExit,
  STDERR_LOG,
  STDERR_LOG_MAX_BYTES,
  type ExitRecord,
} from "./exit-record.js";

const AT = Date.UTC(2026, 8, 28, 18, 45, 57);
const SECRET = "sk-test-0123456789abcdefghijklmnop";

const record = (o: Partial<ExitRecord> = {}): ExitRecord => ({
  ref: "local:9565:1790603534",
  segmentOffset: 484_823,
  exit: { code: 1, stderrTail: `boom: token ${SECRET}\n` },
  redact: [SECRET],
  ...o,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function rawLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "frm-exit-"));
  dirs.push(dir);
  return join(dir, "stdout.jsonl");
}

describe("renderExit", () => {
  test("the header names the process, its code and signal, the time and the segment", () => {
    const text = renderExit(
      record({ exit: { signal: "SIGKILL", stderrTail: "" } }),
      AT,
      false,
    );
    expect(text).toBe(
      "--- frm: process local:9565:1790603534 exited: code=- signal=SIGKILL at 2026-09-28T18:45:57.000Z (raw log segment from offset 484823)\n",
    );
  });

  test("the stderr tail follows, with every secret of the process redacted", () => {
    const text = renderExit(record(), AT, false);
    expect(text).toContain("code=1 signal=-");
    expect(text).toContain(`boom: token ${REDACTED}\n`);
    expect(text).not.toContain(SECRET);
  });

  test("a tail cut inside a secret: the part that survived the cut is redacted too", () => {
    // The adapter keeps the last bytes of stderr, so the tail can begin anywhere in a value.
    const text = renderExit(
      record({
        exit: { code: 1, stderrTail: `${SECRET.slice(6)} and more\n` },
      }),
      AT,
      false,
    );
    expect(text).not.toContain(SECRET.slice(6));
    expect(text).toContain(REDACTED);
    expect(text).toContain(" and more\n");
  });

  test("a tail that ends inside a secret: its head is redacted", () => {
    const text = renderExit(
      record({ exit: { code: 1, stderrTail: `oops ${SECRET.slice(0, 20)}` } }),
      AT,
      false,
    );
    expect(text).not.toContain(SECRET.slice(0, 20));
    expect(text).toContain("oops ");
  });

  test("a tail without a final newline gets one", () => {
    const text = renderExit(
      record({ exit: { code: 0, stderrTail: "last words" } }),
      AT,
      false,
    );
    expect(text.endsWith("last words\n")).toBe(true);
  });

  test("past the cap: the header only, and a note that stderr was left out", () => {
    const text = renderExit(record(), AT, true);
    expect(text).toContain("code=1");
    expect(text).toContain("past its cap");
    expect(text).not.toContain("boom");
  });
});

describe("appendExitRecord", () => {
  test("appends to stderr.log beside the raw log, owner-only, one record per exit", async () => {
    const raw = rawLog();
    const first = await appendExitRecord(raw, record(), AT);
    const second = await appendExitRecord(
      raw,
      record({ exit: { signal: "SIGTERM", stderrTail: "" } }),
      AT + 1,
    );
    expect(first).toEqual({ ok: true, value: join(raw, "..", STDERR_LOG) });
    expect(second.ok).toBe(true);
    const file = join(raw, "..", STDERR_LOG);
    const text = readFileSync(file, "utf8");
    expect(text.match(/^--- frm: process /gm)).toHaveLength(2);
    expect(text).not.toContain(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a file at its cap takes headers only", async () => {
    const raw = rawLog();
    const file = join(raw, "..", STDERR_LOG);
    writeFileSync(file, "x".repeat(STDERR_LOG_MAX_BYTES), { mode: 0o600 });
    const done = await appendExitRecord(raw, record(), AT);
    expect(done.ok).toBe(true);
    const added = readFileSync(file, "utf8").slice(STDERR_LOG_MAX_BYTES);
    expect(added).toContain("code=1");
    expect(added).not.toContain("boom");
  });

  test("a stderr.log that is a symlink is refused, and its target left alone", async () => {
    const raw = rawLog();
    const target = join(raw, "..", "elsewhere");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(raw, "..", STDERR_LOG));
    const done = await appendExitRecord(raw, record(), AT);
    expect(done.ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  test("an existing file with a looser mode is set back to owner-only", async () => {
    const raw = rawLog();
    const file = join(raw, "..", STDERR_LOG);
    writeFileSync(file, "", { mode: 0o644 });
    expect((await appendExitRecord(raw, record(), AT)).ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a directory that is not there: an error, never a throw", async () => {
    const done = await appendExitRecord(
      "/nonexistent/frm/stdout.jsonl",
      record(),
      AT,
    );
    expect(done.ok).toBe(false);
  });
});
