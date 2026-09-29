import { describe, expect, test } from "vitest";
import {
  MAX_FINDING_LINE_CHARS,
  MAX_REVIEW_OUTPUT_CHARS,
  parseHeuristicFindings,
  parseReviewOutput,
} from "./findings.js";

// Reviewer output is untrusted: the parsers' work is linear and bounded (PR #41 review, HIGH 1).
// The old path pattern backtracked quadratically: ~3.2 s on one 80k-character line.

/** U+2028: `.` does not match it and a line split on \n keeps it, so `(\S.*)$` fails at the end. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};

describe("one hostile line", () => {
  test.each([
    ["a path-like run", `- [major] ${"a.".repeat(100_000)}!`],
    ["a run of path characters", `- [major] ${"a-".repeat(100_000)}`],
    [
      "whitespace before a line separator",
      `- [major] x${" ".repeat(200_000)}${LINE_SEPARATOR}`,
    ],
    ["an unclosed brace", `{${"a".repeat(200_000)}`],
  ])(
    "200k characters of %s parse in < 50 ms, and hold no finding",
    (_, line) => {
      const { value, ms } = timed(() => parseHeuristicFindings(line));
      expect(value).toEqual({ findings: [], parse: "heuristic" });
      expect(ms).toBeLessThan(50);
    },
  );

  test("a line longer than MAX_FINDING_LINE_CHARS is never a finding", () => {
    const tag = "- [major] ";
    const fits = `${tag}${"x".repeat(MAX_FINDING_LINE_CHARS - tag.length)}`;
    expect(parseHeuristicFindings(fits).findings).toHaveLength(1);
    expect(parseHeuristicFindings(`${fits}x`).findings).toEqual([]);
  });
});

describe("bounded total input", () => {
  test("a megabyte of worst-case lines just under the line cap parses in linear time", () => {
    // Each line is tagged and near the cap, so both patterns run in full on every one.
    const hostile = [
      `- [major] ${"a.".repeat(244)}!`,
      `- [minor] src/${"a-".repeat(242)} `,
      `- [nit] x${" ".repeat(488)}${LINE_SEPARATOR}`,
    ];
    // The first two tags are findings (no path: the run is not path-like); the third never matches.
    const lines = Array.from({ length: 1_950 }, (_, i) => hostile[i % 3]);
    const text = lines.join("\n");
    expect(text.length).toBeLessThanOrEqual(MAX_REVIEW_OUTPUT_CHARS);
    expect(Math.max(...lines.map((l) => String(l).length))).toBeLessThanOrEqual(
      MAX_FINDING_LINE_CHARS,
    );
    const { value, ms } = timed(() => parseReviewOutput(text, false));
    expect(value.ok && value.value.findings.length).toBe(1_300);
    expect(ms).toBeLessThan(250);
  });

  test.each([true, false])(
    "output over MAX_REVIEW_OUTPUT_CHARS is refused (outputSchema: %s)",
    (outputSchema) => {
      const { value, ms } = timed(() =>
        parseReviewOutput(
          "x".repeat(MAX_REVIEW_OUTPUT_CHARS + 1),
          outputSchema,
        ),
      );
      expect(value).toMatchObject({
        ok: false,
        error: {
          class: "validation",
          message: expect.stringContaining("over the 1000000 cap"),
        },
      });
      expect(ms).toBeLessThan(50);
    },
  );
});
