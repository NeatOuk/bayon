// compressToolResult: one tool result block in, the block out unchanged (with why) or compressed
// by one rule and ended by one marker line (spec M12, §8.5 / §8.7; design docs/spikes). A pure
// function of the text, the original's path and CONTEXT_RULESET: no clock, locale, environment or
// file, so a re-sent history compresses to the same bytes and the prompt-cache prefix holds.
import { MAX_OUTPUT_PERCENT } from "./constants.js";
import { isUnifiedDiff } from "./guards.js";
import { jsonArrayRule } from "./json-array.js";
import { lineRules, type LinesBody } from "./lines.js";
import {
  contextMarker,
  isMarkerPath,
  type ContextRule,
  type MarkerFacts,
} from "./marker.js";
import {
  needsCompression,
  splitText,
  utf8Bytes,
  type TextLines,
} from "./text.js";

export { needsCompression } from "./text.js";

export type UnchangedReason =
  /** Within §8.5's cap. */
  | "small"
  /** Diff or patch output: never compressed. */
  | "diff"
  /** The original's path cannot be printed on one marker line. */
  | "bad_path"
  /** JSON whose numbers would not survive re-serialising. */
  | "precision"
  /** The error lines (or items) alone are over the budget. */
  | "errors_over_budget"
  /** No rule got the block, marker included, to at most 70 % of its chars. */
  | "no_gain";

export type Compression =
  | { readonly kind: "unchanged"; readonly reason: UnchangedReason }
  | {
      readonly kind: "compressed";
      readonly text: string;
      readonly rule: ContextRule;
      /** Original lines not in the output (folded, omitted); cut lines count as kept. */
      readonly omittedLines: number;
      /** json-array: items not in the output; the line rules: 0. */
      readonly omittedItems: number;
      /** Error lines kept verbatim (json-array: error items kept). */
      readonly keptErrorLines: number;
      /** UTF-16 code units. */
      readonly charsIn: number;
      readonly charsOut: number;
    };

export interface CompressOptions {
  /** Where the caller stored the original; the marker names it. */
  readonly originalPath: string;
}

const unchanged = (reason: UnchangedReason): Compression => ({
  kind: "unchanged",
  reason,
});

/** One rule's body before the marker, and what the marker and result say of it. */
interface Body {
  readonly lines: readonly string[];
  readonly rule: ContextRule;
  readonly unit: "items" | "lines";
  readonly omitted: number;
  readonly total: number;
  readonly errors: number;
  readonly omittedLines: number;
  readonly omittedItems: number;
}

/** The body, the marker last, the input's line ending; null when that is over 70 % of the input. */
function finish(
  text: string,
  split: TextLines,
  body: Body,
  originalPath: string,
): Compression | null {
  const facts: MarkerFacts = {
    linesIn: split.lines.length,
    bytesIn: utf8Bytes(text),
    linesKept: body.lines.length,
    rule: body.rule,
    unit: body.unit,
    omitted: body.omitted,
    total: body.total,
    errors: body.errors,
    originalPath,
  };
  const { eol } = split;
  const out = [...body.lines, contextMarker(facts)].join(eol);
  const whole = split.trailing ? `${out}${eol}` : out;
  if (whole.length * 100 > text.length * MAX_OUTPUT_PERCENT) return null;
  return {
    kind: "compressed",
    text: whole,
    rule: body.rule,
    omittedLines: body.omittedLines,
    omittedItems: body.omittedItems,
    keptErrorLines: body.errors,
    charsIn: text.length,
    charsOut: whole.length,
  };
}

function linesBody(b: LinesBody, linesIn: number): Body {
  const omitted = linesIn - b.keptLines;
  return {
    lines: b.lines,
    rule: b.rule,
    unit: "lines",
    omitted,
    total: linesIn,
    errors: b.errorLines,
    omittedLines: omitted,
    omittedItems: 0,
  };
}

/**
 * Compresses one tool result block, or says why not. Guards first (small, diff, bad path), then
 * json-array, then dedupe and head-tail; a result over 70 % of the input is no gain.
 */
export function compressToolResult(
  text: string,
  { originalPath }: CompressOptions,
): Compression {
  if (!needsCompression(text)) return unchanged("small");
  if (isUnifiedDiff(text)) return unchanged("diff");
  if (!isMarkerPath(originalPath)) return unchanged("bad_path");
  const split = splitText(text);
  const json = jsonArrayRule(text);
  if (json.kind === "decline") return unchanged(json.reason);
  if (json.kind === "body") {
    const lines = json.text.split("\n");
    const done = finish(
      text,
      split,
      {
        lines,
        rule: "json-array",
        unit: "items",
        omitted: json.omittedItems,
        total: json.items,
        errors: json.errorItems,
        omittedLines: Math.max(0, split.lines.length - lines.length),
        omittedItems: json.omittedItems,
      },
      originalPath,
    );
    if (done !== null) return done;
  }
  const linesIn = split.lines.length;
  const verdict = lineRules(split.lines);
  if (verdict.kind === "body") {
    return (
      finish(text, split, linesBody(verdict, linesIn), originalPath) ??
      unchanged("no_gain")
    );
  }
  const fallback =
    verdict.fallback === null
      ? null
      : finish(text, split, linesBody(verdict.fallback, linesIn), originalPath);
  return fallback ?? unchanged(verdict.reason);
}
