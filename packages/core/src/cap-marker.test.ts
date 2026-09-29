import { expect, test } from "vitest";
import { parseTruncationMarker, truncationMarker } from "./cap-marker.js";

const facts = { lines: 812, bytes: 90_210, path: "/r/s/logs/tool/mcp-01J.txt" };

test("the marker is one fixed line, the one ingest's cap already writes", () => {
  expect(truncationMarker(facts)).toBe(
    "… truncated: 812 lines, 90210 bytes; full output in /r/s/logs/tool/mcp-01J.txt …",
  );
});

test("a projection with exactly one whole-line marker yields its facts", () => {
  const text = ["head 1", "head 2", truncationMarker(facts), "tail 1"].join(
    "\n",
  );
  expect(parseTruncationMarker(text)).toEqual(facts);
});

test("a path with spaces round-trips", () => {
  const spaced = { ...facts, path: "/tmp/a dir/logs/tool/x.txt" };
  expect(parseTruncationMarker(`a\n${truncationMarker(spaced)}\nb`)).toEqual(
    spaced,
  );
});

test("no marker, two markers, or a marker inside a line yield nothing", () => {
  expect(parseTruncationMarker("plain output\nno marker")).toBeUndefined();
  const one = truncationMarker(facts);
  expect(parseTruncationMarker(`${one}\nmiddle\n${one}`)).toBeUndefined();
  expect(parseTruncationMarker(`prefix ${one}`)).toBeUndefined();
  expect(parseTruncationMarker(`${one} suffix`)).toBeUndefined();
});

test("counts that are not safe integers yield nothing", () => {
  const huge = "9".repeat(20);
  expect(
    parseTruncationMarker(
      `… truncated: ${huge} lines, 1 bytes; full output in /p …`,
    ),
  ).toBeUndefined();
  expect(
    parseTruncationMarker(`… truncated: 1 lines, x bytes; full output in /p …`),
  ).toBeUndefined();
});
