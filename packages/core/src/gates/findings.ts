import { z } from "zod";
import { err, ok, type Result } from "../errors.js";
import { FindingSeverity, type FindingsParse } from "./schemas.js";

// What a reviewer emits (M3 amendment: reviewers emit structured output against our findings
// schema; the daemon decides). A runner with `outputSchema` is handed REVIEW_OUTPUT_JSON_SCHEMA and
// its output is parsed strictly; any other runner's free text goes through the heuristic parser.
// Reviewer output is untrusted input: every parser here is linear in its text, and the entry point
// refuses text over MAX_REVIEW_OUTPUT_CHARS.

/** Review output beyond this is refused in either mode: the bound on the parsers' work. */
export const MAX_REVIEW_OUTPUT_CHARS = 1_000_000;
/** A longer line is never a finding (findings are one-liners), so it is not matched at all. */
export const MAX_FINDING_LINE_CHARS = 500;

const nonBlank = (s: string): boolean => s.trim().length > 0;

/**
 * One finding. Every key is required, nullable where it may be absent, and no other key is
 * allowed, so the JSON Schema suits strict structured-output modes. Refinements stay out of it.
 */
export const ReviewFinding = z.strictObject({
  severity: FindingSeverity,
  summary: z.string().refine(nonBlank, "summary is blank"),
  file: z.string().nullable(),
  line: z
    .number()
    .nullable()
    .refine(
      (n) => n === null || (Number.isInteger(n) && n > 0),
      "line is a positive integer",
    ),
  category: z.string().nullable(),
  detail_md: z.string().nullable(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** A reviewer's whole output: a one-paragraph summary and its findings (none is a clean review). */
export const ReviewOutput = z.strictObject({
  summary: z.string(),
  findings: z.array(ReviewFinding),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** ReviewOutput as JSON Schema, for a runner that constrains its output to one. */
export const REVIEW_OUTPUT_JSON_SCHEMA = z.toJSONSchema(ReviewOutput);

export interface ParsedFindings {
  readonly findings: readonly ReviewFinding[];
  readonly parse: FindingsParse;
}

const NOT_JSON = Symbol("not JSON");

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON; // the callers turn this into their own answer
  }
}

/** Output produced against REVIEW_OUTPUT_JSON_SCHEMA: parsed strictly, or a validation error. */
export function parseSchemaFindings(text: string): Result<ParsedFindings> {
  const json = parseJson(text);
  if (json === NOT_JSON) {
    return err({
      class: "validation",
      message: "review output is not JSON",
      retryable: false,
    });
  }
  const parsed = ReviewOutput.safeParse(json);
  return parsed.success
    ? ok({ findings: parsed.data.findings, parse: "schema" })
    : err({
        class: "validation",
        message: `review output fails the findings schema: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}

/** Fenced blocks first, then the span from the first `{` to the last `}`. */
function jsonCandidates(text: string): string[] {
  const fenced = text
    .split("```")
    .filter((_, i) => i % 2 === 1)
    .map((block) => block.replace(/^\w*/, ""));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start
    ? [...fenced, text.slice(start, end + 1)]
    : fenced;
}

function embeddedOutput(text: string): readonly ReviewFinding[] | null {
  for (const candidate of jsonCandidates(text)) {
    const parsed = ReviewOutput.safeParse(parseJson(candidate));
    if (parsed.success) return parsed.data.findings;
  }
  return null;
}

// The two line patterns never put two unbounded quantifiers over the same characters side by side,
// so a failing match backtracks linearly, not quadratically.

/**
 * A severity-tagged line: an optional bullet or number, then the severity bracketed, parenthesised,
 * bold or followed by a colon ("[major]", "(nit)", "**Blocker**", "**Minor:**", "MAJOR:"). A bare
 * word ("Minor improvements…") is prose, not a tag.
 */
const TAGGED =
  /^\s*(?:(?:[-*+]|\d+[.)])\s*)?[[(*_]*(blocker|major|minor|nit)(?::?[\])*_]+:?|:)\s*(?:[-–—:]\s*)?(\S.*)$/i;
/**
 * A leading `path[:line]`, then a separator and the summary. The path is one atomic run of
 * `[\w./-]` (captured in a lookahead, so it never gives characters back); pathLike() decides
 * whether that run is a path.
 */
const LOCATED = /^`?(?=([\w./-]+))\1(?::(\d+))?`?(?:\s*[-–—:]|\s)\s*(\S.*)$/;

/** A path holds a `.` or `/` and ends in a word character ("e.g." and "naming" are not paths). */
const pathLike = (run: string): boolean => /[/.]/.test(run) && /\w$/.test(run);

function taggedFinding(severity: string, rest: string): ReviewFinding {
  const at = LOCATED.exec(rest.trimEnd());
  const base = {
    severity: FindingSeverity.parse(severity.toLowerCase()),
    category: null,
    detail_md: null,
  };
  if (at === null || !pathLike(String(at[1]))) {
    return { ...base, summary: rest.trim(), file: null, line: null };
  }
  const line = at[2];
  return {
    ...base,
    summary: String(at[3]),
    file: String(at[1]),
    line: line === undefined ? null : Number(line),
  };
}

/**
 * Findings from a runner without `outputSchema`: a ReviewOutput JSON embedded in the text when one
 * validates, else one finding per severity-tagged line of at most MAX_FINDING_LINE_CHARS. Never
 * fails: text with neither holds no findings.
 */
export function parseHeuristicFindings(text: string): ParsedFindings {
  const embedded = embeddedOutput(text);
  if (embedded !== null) return { findings: embedded, parse: "heuristic" };
  const findings = text.split(/\r?\n/).flatMap((line) => {
    if (line.length > MAX_FINDING_LINE_CHARS) return [];
    const tag = TAGGED.exec(line);
    return tag === null ? [] : [taggedFinding(String(tag[1]), String(tag[2]))];
  });
  return { findings, parse: "heuristic" };
}

/** The heuristic review's last line (review v2, C2): `FINDINGS: <n>`, the count it reported. */
const SENTINEL = /^FINDINGS:[ \t]*(\d{1,6})[ \t]*$/;

/**
 * The count a heuristic review's sentinel line declares, or null when its last non-blank line is
 * not one. The parser never fails, so this is what tells "no findings" from "never reviewed".
 */
export function countSentinel(text: string): number | null {
  const last = text
    .split(/\r?\n/)
    .findLast((line) => line.trim().length > 0)
    ?.trim();
  if (last === undefined || last.length > 32) return null;
  const match = SENTINEL.exec(last);
  return match === null ? null : Number(match[1]);
}

/**
 * A reviewer's output by its runner's capability: strict for `outputSchema`, else heuristic. Text
 * over MAX_REVIEW_OUTPUT_CHARS is a validation error in either mode.
 */
export function parseReviewOutput(
  text: string,
  outputSchema: boolean,
): Result<ParsedFindings> {
  if (text.length > MAX_REVIEW_OUTPUT_CHARS) {
    return err({
      class: "validation",
      message: `review output is ${text.length} characters, over the ${MAX_REVIEW_OUTPUT_CHARS} cap`,
      retryable: false,
    });
  }
  return outputSchema
    ? parseSchemaFindings(text)
    : ok(parseHeuristicFindings(text));
}
