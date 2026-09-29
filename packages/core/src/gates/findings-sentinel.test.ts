import { expect, test } from "vitest";
import { countSentinel, parseHeuristicFindings } from "./findings.js";

// review v2's closing line (C2): the heuristic parser never fails, so the sentinel is what tells a
// clean review from one that never looked.

test("the last non-blank line declares the count", () => {
  expect(countSentinel("[major] src/a.ts:3 — wrong\nFINDINGS: 1\n")).toBe(1);
  expect(countSentinel("Looks good.\n\nFINDINGS: 0\n\n")).toBe(0);
  expect(countSentinel("FINDINGS:   12  ")).toBe(12);
});

test("no sentinel, or one that is not last, is null", () => {
  expect(countSentinel("")).toBeNull();
  expect(countSentinel("I could not read the diff.")).toBeNull();
  expect(countSentinel("FINDINGS: 1\n[major] src/a.ts:3 — wrong")).toBeNull();
});

test("a malformed sentinel is null", () => {
  expect(countSentinel("FINDINGS: one")).toBeNull();
  expect(countSentinel("FINDINGS: -1")).toBeNull();
  expect(countSentinel("findings: 1")).toBeNull();
  expect(countSentinel("FINDINGS: 1234567")).toBeNull();
  expect(countSentinel(`FINDINGS: 1${" ".repeat(40)}x`)).toBeNull();
});

test("the sentinel line is never parsed as a finding", () => {
  const text = "[minor] src/a.ts:3 — naming\nFINDINGS: 1";
  expect(parseHeuristicFindings(text).findings).toHaveLength(1);
  expect(countSentinel(text)).toBe(1);
});
