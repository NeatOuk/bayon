import { describe, expect, test } from "vitest";
import { compressToolResult, type Compression } from "./compress.js";
import { isErrorLine } from "./constants.js";
import { CONTEXT_RULES } from "./marker.js";
import { MARKER_LINE, randomJsonArray, randomLog, seeded } from "./fixtures.js";

// Properties over seeded random blocks: error lines and error items always survive, the marker is
// one line and the last, and a compressed block is at most 70 % of the input.
const opts = { originalPath: "/w/.foreman/ctx/ff.txt" };
const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);
const UNCHANGED_OK = ["small", "no_gain", "errors_over_budget"];

const linesOf = (text: string) => text.replace(/\r?\n$/, "").split(/\r?\n/);

/** The body above the one marker line, which must be the last. */
function bodyOf(c: Extract<Compression, { kind: "compressed" }>): string[] {
  const lines = linesOf(c.text);
  expect(lines.filter((l) => l.startsWith("[frm-ctx "))).toHaveLength(1);
  expect(lines.at(-1)).toMatch(MARKER_LINE);
  expect(c.charsOut * 100).toBeLessThanOrEqual(c.charsIn * 70);
  expect(c.charsOut).toBe(c.text.length);
  return lines.slice(0, -1);
}

/** Every error line of the input is in the body, verbatim and in order. */
function expectErrorLinesKept(input: string, body: readonly string[]) {
  const errors = linesOf(input).filter((l) => isErrorLine(l));
  let found = 0;
  for (const line of body) {
    if (found < errors.length && line === errors[found]) found += 1;
  }
  expect(found).toBe(errors.length);
  return errors.length;
}

describe("random logs with planted error lines", () => {
  const kinds: string[] = [];

  test.each(SEEDS)("seed %i", (seed) => {
    const log = randomLog(seeded(seed));
    const planted = linesOf(log.text).filter((l) => isErrorLine(l));
    for (const e of log.errorLines) expect(planted).toContain(e);
    const c = compressToolResult(log.text, opts);
    kinds.push(c.kind === "compressed" ? c.rule : c.reason);
    if (c.kind === "unchanged") {
      expect(UNCHANGED_OK).toContain(c.reason);
      return;
    }
    const body = bodyOf(c);
    expect(c.keptErrorLines).toBe(expectErrorLinesKept(log.text, body));
    const crlf = log.text.includes("\r\n");
    expect(c.text.replace(/\r\n/g, "").includes("\n")).toBe(!crlf);
    expect(/\r?\n$/.test(c.text)).toBe(/\r?\n$/.test(log.text));
  });

  test("most of them compress, so the properties are not vacuous", () => {
    const rules: readonly string[] = CONTEXT_RULES;
    const compressed = kinds.filter((k) => rules.includes(k));
    expect(compressed.length).toBeGreaterThan(SEEDS.length * 0.8);
  });
});

describe("random JSON arrays with planted error items", () => {
  const rules: string[] = [];

  test.each(SEEDS)("seed %i", (seed) => {
    const wrap = seed % 3 === 0;
    const json = randomJsonArray(seeded(seed * 7_919), wrap);
    const c = compressToolResult(json.text, opts);
    if (c.kind === "unchanged") {
      expect(UNCHANGED_OK).toContain(c.reason);
      return;
    }
    rules.push(c.rule);
    const body = bodyOf(c);
    if (c.rule !== "json-array") {
      expectErrorLinesKept(json.text, body);
      return;
    }
    const value = JSON.parse(body.join("\n")) as unknown;
    const items = (
      wrap ? (value as { items: unknown[] }).items : value
    ) as unknown[];
    const present = new Set(
      items.filter((x) => typeof x !== "string").map((x) => JSON.stringify(x)),
    );
    for (const e of json.errorItems) {
      expect(present.has(JSON.stringify(e))).toBe(true);
    }
    expect(c.keptErrorLines).toBe(json.errorItems.length);
    expect(c.omittedItems).toBe(
      items.reduce<number>(
        (sum, x) =>
          typeof x === "string"
            ? sum + Number(/^… (\d+) items/.exec(x)?.[1])
            : sum,
        0,
      ),
    );
  });

  test("json-array is what compresses most of them", () => {
    expect(rules.filter((r) => r === "json-array").length).toBeGreaterThan(
      rules.length * 0.8,
    );
  });
});
