// §8.5's backstop for MCP results. Paging keeps results small; anything still
// over the cap goes whole to the session's logs/tool/, and the agent gets head, one marker line (the
// one ingest parses) and tail, within the cap.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, truncationMarker, type Result } from "@bayon/core";

const HEAD_LINES = 60;

export interface CapLimits {
  readonly bytes: number;
  readonly lines: number;
}

export interface Capped {
  readonly text: string;
}

const bytesOf = (s: string) => Buffer.byteLength(s, "utf8");

/** At most `max` bytes from the start of `s`, never splitting a character. */
export function headBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let end = max;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/** At most `max` bytes from the end of `s`, never splitting a character. */
function tailBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let start = buf.length - max;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

/** Keeps the whole text somewhere only this session's ingest will vouch for. */
function keep(text: string, toolDir: string, fileId: string): Result<string> {
  const path = join(toolDir, `mcp-${fileId}.txt`);
  try {
    mkdirSync(toolDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
    return ok(path);
  } catch (e) {
    return err({
      class: "internal",
      message: `cannot keep a full MCP result: ${String(e)}`,
      retryable: false,
    });
  }
}

/**
 * `text` when within `limits`; otherwise head, a marker naming the kept file (or saying it was not
 * kept, without a runtime dir) and tail, within `limits`.
 */
export function capResult(
  text: string,
  o: {
    readonly limits: CapLimits;
    readonly toolDir: string | null;
    readonly fileId: string;
  },
): Result<Capped> {
  const lines = text.split("\n");
  const size = bytesOf(text);
  if (size <= o.limits.bytes && lines.length <= o.limits.lines) {
    return ok({ text });
  }
  const kept = o.toolDir === null ? null : keep(text, o.toolDir, o.fileId);
  if (kept !== null && !kept.ok) return kept;
  const middle =
    kept === null
      ? `… truncated: ${lines.length} lines, ${size} bytes; the full output was not kept …`
      : truncationMarker({
          lines: lines.length,
          bytes: size,
          path: kept.value,
        });
  const each = Math.max(
    1,
    Math.min(HEAD_LINES, Math.floor((o.limits.lines - 1) / 2)),
  );
  const half = Math.max(
    0,
    Math.floor((o.limits.bytes - bytesOf(middle) - 2) / 2),
  );
  const head = headBytes(lines.slice(0, each).join("\n"), half);
  const tail = tailBytes(
    lines.slice(Math.max(each, lines.length - each)).join("\n"),
    half,
  );
  return ok({ text: `${head}\n${middle}\n${tail}` });
}
