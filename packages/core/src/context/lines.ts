// The line rules. dedupe folds runs of similar lines, keeping the first and a counted range;
// head-tail keeps both ends, every error line and its stack continuation, and cuts long lines.
// Neither ever drops or folds a line matching the error pattern.
import {
  DEDUPE_MIN_RUN,
  ERROR_BUDGET_BYTES,
  HEAD_LINES,
  LONG_LINE_BYTES,
  STACK_CONTINUATION_LINES,
  TAIL_LINES,
  isErrorLine,
} from "./constants.js";
import type { ContextRule } from "./marker.js";
import { cutLine, needsCompression, utf8Bytes } from "./text.js";

/** One original line, numbered from 1. */
export interface Line {
  readonly kind: "line";
  readonly no: number;
  readonly text: string;
  readonly error: boolean;
}

/** The similar lines `from`–`to` folded after the one line kept of their run. */
export interface Fold {
  readonly kind: "fold";
  readonly from: number;
  readonly to: number;
}

export type LineItem = Line | Fold;

/** Lines are similar when equal once every run of digits reads `0`. */
const similarKey = (line: string) => line.replace(/\d+/g, "0");

/** Indented, or an unindented `at …` frame: what follows an error line as its trace. */
const CONTINUATION = /^(?:[ \t]+\S|at\s)/;

/**
 * A fold continues a trace: it always follows its run's first line, so the scan only reaches it
 * when that line continued the trace, and the folded lines are like it.
 */
const isContinuation = (item: LineItem) =>
  item.kind === "fold" || CONTINUATION.test(item.text);

const firstNo = (item: LineItem) =>
  item.kind === "line" ? item.no : item.from;
const lastNo = (item: LineItem) => (item.kind === "line" ? item.no : item.to);

/** Consecutive similar lines; an error line is always a run of its own (`key` null). */
interface Run {
  readonly key: string | null;
  readonly first: Line;
  last: Line;
  readonly lines: Line[];
}

/** Runs of `DEDUPE_MIN_RUN`+ similar non-error lines become their first line and one fold. */
export function dedupe(lines: readonly string[]): LineItem[] {
  const runs: Run[] = [];
  lines.forEach((text, i) => {
    const line: Line = {
      kind: "line",
      no: i + 1,
      text,
      error: isErrorLine(text),
    };
    const key = line.error ? null : similarKey(text);
    const run = runs.at(-1);
    if (run !== undefined && key !== null && key === run.key) {
      run.lines.push(line);
      run.last = line;
    } else {
      runs.push({ key, first: line, last: line, lines: [line] });
    }
  });
  return runs.flatMap((run): LineItem[] =>
    run.lines.length >= DEDUPE_MIN_RUN
      ? [run.first, { kind: "fold", from: run.first.no + 1, to: run.last.no }]
      : run.lines,
  );
}

const foldNote = (from: number, to: number) =>
  `… ×${to - from + 1} similar lines (L${from}–L${to})`;

const gapNote = (from: number, to: number) =>
  `… ${to - from + 1} lines omitted (L${from}–L${to})`;

/** An item as it reads in the output; head-tail cuts a long non-error line. */
function render(item: LineItem, cut: boolean): string {
  if (item.kind === "fold") return foldNote(item.from, item.to);
  return cut && !item.error ? cutLine(item.text, LONG_LINE_BYTES) : item.text;
}

/**
 * Which items head-tail keeps: both ends, every error line, and up to 30 continuations after it;
 * and a lone item between two kept ones, since a gap line would cost as much as the item.
 */
function keptByHeadTail(items: readonly LineItem[]): readonly boolean[] {
  const n = items.length;
  const kept = items.map((_, i) => i < HEAD_LINES || i >= n - TAIL_LINES);
  items.forEach((item, e) => {
    if (item.kind === "fold" || !item.error) return;
    kept[e] = true;
    const after = items.slice(e + 1, e + 1 + STACK_CONTINUATION_LINES);
    const stop = after.findIndex((next) => !isContinuation(next));
    const trace = stop === -1 ? after.length : stop;
    for (let k = 1; k <= trace; k += 1) kept[e + k] = true;
  });
  return kept.map(
    (k, i) => k || (kept[i - 1] === true && kept[i + 1] === true),
  );
}

/**
 * Kept items rendered, each run of the rest (folds included) as one gap line. The last item is
 * always in the tail, so no gap ends the output.
 */
function headTail(
  items: readonly LineItem[],
  kept: readonly boolean[],
): string[] {
  const out: string[] = [];
  let gapFrom: number | null = null;
  let gapTo = 0;
  items.forEach((item, i) => {
    if (!kept[i]) {
      gapFrom ??= firstNo(item);
      gapTo = lastNo(item);
      return;
    }
    if (gapFrom !== null) out.push(gapNote(gapFrom, gapTo));
    gapFrom = null;
    out.push(render(item, true));
  });
  return out;
}

export interface LinesBody {
  readonly kind: "body";
  readonly rule: Exclude<ContextRule, "json-array">;
  readonly lines: readonly string[];
  /** Original lines still in the body, whole or cut. */
  readonly keptLines: number;
  readonly errorLines: number;
}

export type LinesVerdict =
  | LinesBody
  | {
      readonly kind: "decline";
      readonly reason: "errors_over_budget";
      /** The dedupe-only body, when dedupe folded anything: every error line is still in it. */
      readonly fallback: LinesBody | null;
    };

const countLines = (items: readonly LineItem[]) =>
  items.filter((item) => item.kind === "line").length;

/**
 * dedupe, then head-tail when the deduped text is still over the threshold. When the error lines
 * alone are over the budget, head-tail declines.
 */
export function lineRules(lines: readonly string[]): LinesVerdict {
  const items = dedupe(lines);
  const errors = items.filter(
    (item): item is Line => item.kind === "line" && item.error,
  );
  const folded = items.length < lines.length;
  const deduped: LinesBody = {
    kind: "body",
    rule: "dedupe",
    lines: items.map((item) => render(item, false)),
    keptLines: countLines(items),
    errorLines: errors.length,
  };
  if (folded && !needsCompression(deduped.lines.join("\n"))) return deduped;
  const errorBytes = errors.reduce((sum, e) => sum + utf8Bytes(e.text), 0);
  if (errorBytes > ERROR_BUDGET_BYTES) {
    return {
      kind: "decline",
      reason: "errors_over_budget",
      fallback: folded ? deduped : null,
    };
  }
  const kept = keptByHeadTail(items);
  return {
    kind: "body",
    rule: folded ? "dedupe+head-tail" : "head-tail",
    lines: headTail(items, kept),
    keptLines: countLines(items.filter((_, i) => kept[i])),
    errorLines: errors.length,
  };
}
