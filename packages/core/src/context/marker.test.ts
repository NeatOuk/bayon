import { describe, expect, test } from "vitest";
import { contextMarker, isMarkerPath, type MarkerFacts } from "./marker.js";

const FACTS: MarkerFacts = {
  linesIn: 5012,
  bytesIn: 231 * 1024,
  linesKept: 184,
  rule: "json-array",
  unit: "items",
  omitted: 480,
  total: 500,
  errors: 7,
  originalPath: "/w/.foreman/ctx/ab12.txt",
};

test("the marker is one fixed line naming the rule, the counts and the path", () => {
  expect(contextMarker(FACTS)).toBe(
    "[frm-ctx ctx1] 5012 lines, 231 KB → 184 lines kept (json-array: 480 of 500 items " +
      "omitted; 7 error items kept). Original: /w/.foreman/ctx/ab12.txt — read it with " +
      "offset/limit or grep it.",
  );
});

test("the line rules count lines", () => {
  expect(
    contextMarker({ ...FACTS, rule: "dedupe+head-tail", unit: "lines" }),
  ).toContain(
    "(dedupe+head-tail: 480 of 500 lines omitted; 7 error lines kept)",
  );
});

test.each([
  [1, "1 KB"],
  [1024, "1 KB"],
  [1025, "2 KB"],
  [8193, "9 KB"],
])("%i bytes read %s, rounded up", (bytesIn, kb) => {
  expect(contextMarker({ ...FACTS, bytesIn })).toContain(`lines, ${kb} →`);
});

describe("isMarkerPath: one printable line", () => {
  test.each([
    ["/w/.foreman/ctx/ab.txt", true],
    [".foreman/ctx/ab.txt", true],
    ["/a dir/é/ab.txt", true],
    ["", false],
    ["/a\nb", false],
    ["/a\rb", false],
    ["/a\tb", false],
    ["/a\u0000b", false],
    ["/a\u007fb", false],
    ["/a\u0085b", false],
    ["/a\u2028b", false],
    ["/a\u2029b", false],
  ])("%j → %s", (path, want) => expect(isMarkerPath(path)).toBe(want));
});
