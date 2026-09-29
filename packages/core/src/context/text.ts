// Sizes and lines for the context rules. "KB" is UTF-8 bytes, counted here without a Buffer so the
// module stays pure; "chars" are UTF-16 code units (`String.length`).
import { COMPRESS_MIN_BYTES, COMPRESS_MIN_LINES } from "./constants.js";

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** UTF-8 bytes of the code point at `i`: 4 for a surrogate pair, 3 for a lone surrogate (U+FFFD). */
function widthAt(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  return isHigh(c) && isLow(s.charCodeAt(i + 1)) ? 4 : 3;
}

/** Code units the code point at `i` spans, given its UTF-8 width. */
const unitsOf = (width: number) => (width === 4 ? 2 : 1);

/** The UTF-8 length of `s`, as an encoder would write it. */
export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length;) {
    const width = widthAt(s, i);
    bytes += width;
    i += unitsOf(width);
  }
  return bytes;
}

/** Lines in `text`; a final line break ends the last line rather than starting another. */
export function lineCount(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    lines += 1;
  }
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** Whether a block is over §8.5's cap: more than 8 KB or more than 200 lines. */
export const needsCompression = (text: string): boolean =>
  lineCount(text) > COMPRESS_MIN_LINES || utf8Bytes(text) > COMPRESS_MIN_BYTES;

/** A block as lines: the first line break decides the ending, a final one is remembered. */
export interface TextLines {
  readonly lines: readonly string[];
  readonly eol: "\n" | "\r\n";
  readonly trailing: boolean;
}

export function splitText(text: string): TextLines {
  const first = text.indexOf("\n");
  const eol = first > 0 && text[first - 1] === "\r" ? "\r\n" : "\n";
  const trailing = text.endsWith("\n");
  const body = trailing ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
  return { lines: body.split(/\r?\n/), eol, trailing };
}

/**
 * `line` cut to at most `maxBytes` UTF-8 bytes at a code-point boundary (a surrogate pair is never
 * split), with `…[+N chars]` for what was cut; unchanged when it fits.
 */
export function cutLine(line: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  while (end < line.length) {
    const width = widthAt(line, end);
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += unitsOf(width);
  }
  return end === line.length
    ? line
    : `${line.slice(0, end)}…[+${line.length - end} chars]`;
}
