// JUnit XML, read for the failed cases only. A project that points `workspaces.qa_junit`
// at a report gets one finding per failed case beside the blocking finding naming the command, so a
// fixer reads "3 cases failed, here they are" instead of "the harness exited 1".
//
// Hand-written, and deliberately so. A dependency would be a new supply-chain entry for one file
// format, and an XML parser that throws would turn a harness's answer into `reviewer_error` — the
// gate's verdict lost to the decoration on top of it. So this is a scan, it never throws, and a file
// it cannot make sense of yields no cases and says `malformed`, leaving the exit code to decide.
//
// The format is every runner's own dialect of the same shape: <testsuite> holding <testcase>, a case
// that failed holding <failure> or <error>. Nothing here names a runner or a framework (Invariant 1):
// this reads the shape, and a report that does not have it simply contributes nothing.

/** One failed case. */
export interface JUnitFailure {
  /** `classname`, the suite or file the case belongs to; null when the report gives none. */
  readonly suite: string | null;
  readonly name: string;
  /** The `message` attribute, trimmed and capped; null when there is none. */
  readonly message: string | null;
  /** `failure` (an assertion) or `error` (the case blew up). */
  readonly kind: "failure" | "error";
}

export interface JUnitParse {
  /** The failed cases, in document order, at most `max`. */
  readonly failures: readonly JUnitFailure[];
  /** How many failed cases the report holds, which may be more than `failures.length`. */
  readonly total: number;
  /** How many `<testcase>` elements were seen at all. */
  readonly cases: number;
  /** The text holds no `<testsuite` and no `<testcase`: not a JUnit report, or cut short. */
  readonly malformed: boolean;
}

/** The most failed cases a parse returns; the rest are counted, not listed. */
export const QA_JUNIT_CASES_MAX = 20;
/** The most of a case's `message` a finding carries. */
export const QA_JUNIT_MESSAGE_MAX = 500;
/** Past this many characters the report is not read: the whole of it is an artifact anyway. */
export const QA_JUNIT_BYTES_MAX = 4_000_000;

const ENTITIES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * The five predefined entities and numeric references; anything else is left as written.
 *
 * Nothing here indexes a capture group. A group that always participates still types as
 * `string | undefined`, so every read needs a fallback the tests can never reach — a branch that
 * cannot be covered and must not be excluded. Slicing a match whose shape the pattern already
 * fixed has no such arm.
 */
export function unescapeXml(text: string): string {
  return text.replace(/&(?:#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity) => {
    const known = ENTITIES[entity.toLowerCase()];
    if (known !== undefined) return known;
    if (!/^&#x?[0-9a-fA-F]+;$/i.test(entity)) return entity;
    const digits = entity.slice(2, -1); // past `&#`, before `;`
    const hex = digits.startsWith("x") || digits.startsWith("X");
    const code = Number.parseInt(hex ? digits.slice(1) : digits, hex ? 16 : 10);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10_ff_ff
      ? String.fromCodePoint(code)
      : entity;
  });
}

const cap = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** One attribute of a start tag, unescaped; null when the tag does not carry it. */
function attribute(tag: string, name: string): string | null {
  const found = new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*')`).exec(tag);
  if (found === null) return null;
  // The match is `name="value"` (or the single-quoted form), so the value is what sits between the
  // first quote and the last. The pattern guarantees both, so there is nothing to fall back to.
  const whole = found[0];
  return unescapeXml(whole.slice(whole.search(/["']/) + 1, -1));
}

/** A `<testcase …>` start tag and the body up to its close (empty for a self-closing one). */
interface Case {
  readonly tag: string;
  readonly body: string;
}

const CASE = /<testcase\b[^>]*>/gi;

const CASE_OPEN = "<testcase";

function scanCases(xml: string): Case[] {
  const cases: Case[] = [];
  CASE.lastIndex = 0;
  for (let m = CASE.exec(xml); m !== null; m = CASE.exec(xml)) {
    // `m[0]` is the whole `<testcase …>`; its attributes are what sits between the name and `>`.
    const tag = m[0].slice(CASE_OPEN.length, -1);
    if (tag.trimEnd().endsWith("/")) {
      cases.push({ tag, body: "" });
      continue;
    }
    // Up to this case's close, or — in a report cut off mid-write — to the next case or the end.
    const rest = xml.slice(m.index + m[0].length);
    const close = rest.search(/<\/testcase\s*>|<testcase\b/i);
    cases.push({ tag, body: close === -1 ? rest : rest.slice(0, close) });
  }
  return cases;
}

const FAILED = /<(?:failure|error)\b[^>]*(?:\/>|>)/i;
/** Which of the two a failed case carries; `<failure>` is the assertion, `<error>` the blow-up. */
const ERROR_OPEN = /^<error\b/i;

/**
 * The failed cases of a JUnit report. Never throws: a file that is not XML, or one cut off half way,
 * yields whatever cases it did hold and `malformed` when it held none at all.
 */
export function parseJUnit(
  xml: string,
  max: number = QA_JUNIT_CASES_MAX,
): JUnitParse {
  const text = xml.slice(0, QA_JUNIT_BYTES_MAX);
  const cases = scanCases(text);
  const malformed = cases.length === 0 && !/<testsuites?\b/i.test(text);
  const failures: JUnitFailure[] = [];
  let total = 0;
  for (const c of cases) {
    const failed = FAILED.exec(c.body);
    if (failed === null) continue;
    total += 1;
    if (failures.length >= max) continue;
    const message = attribute(failed[0], "message");
    failures.push({
      suite: attribute(c.tag, "classname"),
      name: attribute(c.tag, "name") ?? "(unnamed case)",
      message:
        message === null || message.trim() === ""
          ? null
          : cap(message.trim(), QA_JUNIT_MESSAGE_MAX),
      kind: ERROR_OPEN.test(failed[0]) ? "error" : "failure",
    });
  }
  return { failures, total, cases: cases.length, malformed };
}
