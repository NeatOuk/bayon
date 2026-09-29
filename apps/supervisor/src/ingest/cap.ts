// What an event keeps in its row, and what goes to disk (§8.5, and §4's reasoning retention).
// Tool results over 8 KB or 200 lines keep head 60 + tail 60 lines; reasoning keeps 4 KB; any
// other text keeps 8 KB; a payload over 8 KB keeps a shortened copy. The full original goes to
// logs/tool/, and payload_path, bytes_original and truncated say so. File names depend only on
// the event and its raw offset, so a replay rewrites the same files.
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  parseTruncationMarker,
  truncationMarker,
  type CanonicalEvent,
  type TruncationFacts,
} from "@bayon/core";

export const TOOL_RESULT_MAX_BYTES = 8 * 1024;
export const TOOL_RESULT_MAX_LINES = 200;
export const HEAD_LINES = 60;
export const TAIL_LINES = 60;
export const REASONING_ROW_BYTES = 4 * 1024;
export const TEXT_MAX_BYTES = 8 * 1024;
export const PAYLOAD_MAX_BYTES = 8 * 1024;
/** Room left in a tool result's projection for the "… truncated …" line. */
const MARKER_BYTES = 512;
/** A call id used as a file name: no separators, no dot files, bounded. */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
/** Ever shorter strings and lists, until the payload fits. */
const SHRINK_LEVELS = [
  [2048, 100],
  [256, 20],
  [64, 5],
  [16, 1],
] as const;

/** The row columns capEvent decides. */
export interface Stored {
  readonly text: string | null;
  readonly payload_json: string;
  readonly payload_path: string | null;
  readonly bytes_original: number | null;
  readonly truncated: 0 | 1;
}

export interface CapOptions {
  readonly toolDir: string;
  /** The event's raw_offset: names spill files for events without a call id. */
  readonly rawOffset: number;
}

type Payload = Readonly<Record<string, unknown>>;

const bytesOf = (s: string) => Buffer.byteLength(s, "utf8");

/** At most `max` bytes from the start of `s`, never splitting a character. */
function headBytes(s: string, max: number): string {
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

function spill(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

/** Head 60 and tail 60 lines, each half within 4 KB, around a line naming the full file. */
function toolProjection(text: string, path: string): string {
  const lines = text.split("\n");
  const half = Math.floor((TOOL_RESULT_MAX_BYTES - MARKER_BYTES) / 2);
  const head = headBytes(lines.slice(0, HEAD_LINES).join("\n"), half);
  const rest =
    lines.length > HEAD_LINES
      ? lines.slice(Math.max(HEAD_LINES, lines.length - TAIL_LINES)).join("\n")
      : text.slice(head.length);
  const marker = headBytes(
    `\n${truncationMarker({ lines: lines.length, bytes: bytesOf(text), path })}\n`,
    MARKER_BYTES,
  );
  return `${head}${marker}${tailBytes(rest, half)}`;
}

/**
 * A result capped upstream (the API's MCP backstop): its one marker line, when that names a regular
 * file inside this session's logs/tool/. Anything else is ignored: an agent can print a marker.
 */
function upstreamSpill(
  text: string,
  toolDir: string,
): TruncationFacts | undefined {
  const facts = parseTruncationMarker(text);
  if (facts === undefined || !isAbsolute(facts.path)) return undefined;
  try {
    const file = realpathSync(facts.path);
    const inside = relative(realpathSync(toolDir), file);
    if (inside === "" || isAbsolute(inside) || inside.split(sep)[0] === "..") {
      return undefined;
    }
    return statSync(file).isFile() ? { ...facts, path: file } : undefined;
  } catch {
    return undefined; // missing or unreadable: nothing this session can vouch for
  }
}

type TextCap = {
  readonly text: string | null;
  readonly path?: string;
  readonly bytes?: number;
  readonly extra?: Payload;
};

function capText(e: CanonicalEvent, o: CapOptions): TextCap {
  if (e.text === undefined) return { text: null };
  const size = bytesOf(e.text);
  if (e.kind === "tool_result") {
    const lines = e.text.split("\n").length;
    if (size <= TOOL_RESULT_MAX_BYTES && lines <= TOOL_RESULT_MAX_LINES) {
      const upstream = upstreamSpill(e.text, o.toolDir);
      return upstream === undefined
        ? { text: e.text, bytes: size }
        : { text: e.text, path: upstream.path, bytes: upstream.bytes };
    }
    const callId = e.payload.call_id;
    const name = SAFE_NAME.test(callId) ? callId : `${o.rawOffset}-${e.kind}`;
    const path = join(o.toolDir, `${name}.txt`);
    spill(path, e.text);
    return {
      text: toolProjection(e.text, path),
      path,
      bytes: size,
      extra: { output_path: path },
    };
  }
  const max = e.kind === "reasoning" ? REASONING_ROW_BYTES : TEXT_MAX_BYTES;
  if (size <= max) return { text: e.text };
  const path = join(o.toolDir, `${o.rawOffset}-${e.kind}.txt`);
  spill(path, e.text);
  return { text: headBytes(e.text, max), path, bytes: size };
}

function shrink(value: unknown, chars: number, items: number): unknown {
  if (typeof value === "string") {
    return value.length > chars ? `${value.slice(0, chars)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, items).map((v) => shrink(v, chars, items));
  }
  if (typeof value === "object" && value !== null) {
    return shrinkObject(value, chars, items);
  }
  return value;
}

const shrinkObject = (value: object, chars: number, items: number): Payload =>
  Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, shrink(v, chars, items)]),
  );

/** A copy of the payload that fits in the row, marked, with the path of the full one. */
function shortPayload(payload: Payload, path: string): string {
  const mark = { truncated_payload: true, payload_path: path };
  for (const [chars, items] of SHRINK_LEVELS) {
    const json = JSON.stringify({
      ...shrinkObject(payload, chars, items),
      ...mark,
    });
    if (bytesOf(json) <= PAYLOAD_MAX_BYTES) return json;
  }
  const scalars = Object.entries(payload).filter(
    ([, v]) => typeof v !== "object" || v === null,
  );
  const json = JSON.stringify({
    ...shrinkObject(Object.fromEntries(scalars), 256, 0),
    ...mark,
  });
  return bytesOf(json) <= PAYLOAD_MAX_BYTES ? json : JSON.stringify(mark);
}

/**
 * The row columns for `e`, writing whatever does not fit to disk first. Throws on a failed
 * write: the caller treats that as fatal (the raw log still holds everything).
 */
export function capEvent(e: CanonicalEvent, o: CapOptions): Stored {
  const text = capText(e, o);
  const payload: Payload = { ...e.payload, ...text.extra };
  const json = JSON.stringify(payload);
  const payloadFits = bytesOf(json) <= PAYLOAD_MAX_BYTES;
  const payloadPath = payloadFits
    ? undefined
    : join(o.toolDir, `${o.rawOffset}-${e.kind}.json`);
  if (payloadPath !== undefined) spill(payloadPath, JSON.stringify(e.payload));
  const path = text.path ?? payloadPath;
  return {
    text: text.text,
    payload_json:
      payloadPath === undefined ? json : shortPayload(payload, payloadPath),
    payload_path: path ?? null,
    bytes_original:
      text.bytes ??
      (payloadPath === undefined ? null : bytesOf(JSON.stringify(e.payload))),
    truncated: path === undefined ? 0 : 1,
  };
}
