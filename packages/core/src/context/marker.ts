// The one line that ends a compressed block: what was kept, what was omitted, and where the whole
// original is (§8.5, "hand the agent the path"). Our own text, never a runner's (Invariant 1).
import { CONTEXT_RULESET } from "./constants.js";

/** The rules, as the marker and a compressed result name them. */
export const CONTEXT_RULES = [
  "json-array",
  "dedupe",
  "head-tail",
  "dedupe+head-tail",
] as const;
export type ContextRule = (typeof CONTEXT_RULES)[number];

/** What the marker says; the path is the caller's, never derived from the content. */
export interface MarkerFacts {
  readonly linesIn: number;
  readonly bytesIn: number;
  /** Lines above the marker. */
  readonly linesKept: number;
  readonly rule: ContextRule;
  /** json-array counts items; the line rules count lines. */
  readonly unit: "items" | "lines";
  readonly omitted: number;
  readonly total: number;
  readonly errors: number;
  readonly originalPath: string;
}

/** Every line break and control character: any of them would split or garble the marker. */
// eslint-disable-next-line no-control-regex -- the point is to match them
const UNSAFE_PATH = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/** Whether `path` can be printed in the marker: non-empty, one line, no control characters. */
export const isMarkerPath = (path: string): boolean =>
  path !== "" && !UNSAFE_PATH.test(path);

/** `bytes` in whole KB, rounded up, so a non-empty block never reads 0 KB. */
const kb = (bytes: number) => Math.ceil(bytes / 1024);

export const contextMarker = (f: MarkerFacts): string =>
  `[frm-ctx ${CONTEXT_RULESET}] ${f.linesIn} lines, ${kb(f.bytesIn)} KB → ` +
  `${f.linesKept} lines kept (${f.rule}: ${f.omitted} of ${f.total} ${f.unit} omitted; ` +
  `${f.errors} error ${f.unit} kept). Original: ${f.originalPath} — read it with ` +
  `offset/limit or grep it.`;
