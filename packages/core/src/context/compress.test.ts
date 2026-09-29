import { describe, expect, test } from "vitest";
import {
  compressToolResult,
  needsCompression,
  type Compression,
} from "./compress.js";
import { MARKER_LINE, realisticJson, realisticTestLog } from "./fixtures.js";

const PATH = "/w/.foreman/ctx/0f.txt";
const opts = { originalPath: PATH };

function compressed(c: Compression) {
  if (c.kind !== "compressed")
    throw new Error(`expected compressed, got ${c.reason}`);
  return c;
}

/** The output's lines without its final line break, and its one marker line (the last). */
function parts(text: string) {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  expect(lines.filter((l) => l.startsWith("[frm-ctx "))).toHaveLength(1);
  const marker = lines.at(-1) ?? "";
  expect(marker).toMatch(MARKER_LINE);
  return { body: lines.slice(0, -1), marker };
}

const distinct = (n: number) =>
  Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `even ${i}` : `odd ${i}`));

describe("guards", () => {
  test.each([
    ["empty", ""],
    ["short", "ok\n"],
    ["200 lines", "x\n".repeat(200)],
    ["8 KB", "x".repeat(8192)],
  ])("%s is small", (_, text) => {
    expect(needsCompression(text)).toBe(false);
    expect(compressToolResult(text, opts)).toEqual({
      kind: "unchanged",
      reason: "small",
    });
  });

  test("a diff is never compressed", () => {
    const diff = `diff --git a/x b/x\n@@ -1,300 +1,300 @@\n${"-a\n+b\n".repeat(300)}`;
    expect(compressToolResult(diff, opts)).toEqual({
      kind: "unchanged",
      reason: "diff",
    });
  });

  test.each(["", "/w/a\nb.txt"])(
    "path %j cannot go on one marker line",
    (originalPath) => {
      expect(
        compressToolResult(distinct(400).join("\n"), { originalPath }),
      ).toEqual({
        kind: "unchanged",
        reason: "bad_path",
      });
    },
  );
});

describe("json-array", () => {
  test("a 500-item array keeps its ends, errors and outliers, with one marker line", () => {
    const text = realisticJson();
    const c = compressed(compressToolResult(text, opts));
    expect(c.rule).toBe("json-array");
    const { body, marker } = parts(c.text);
    const out = JSON.parse(body.join("\n")) as unknown[];
    expect(out.filter((x) => typeof x === "string").length).toBeGreaterThan(0);
    expect(c.omittedItems).toBe(
      500 - out.filter((x) => typeof x !== "string").length,
    );
    expect(c.omittedLines).toBe(text.split("\n").length - 1 - body.length);
    expect(marker).toContain(
      `(json-array: ${c.omittedItems} of 500 items omitted;`,
    );
    expect(marker).toContain(`Original: ${PATH} —`);
    expect(c.charsIn).toBe(text.length);
    expect(c.charsOut).toBe(c.text.length);
    expect(c.text.endsWith("\n")).toBe(true);
  });

  test("compact JSON on one line omits items, not lines", () => {
    const items = Array.from({ length: 600 }, (_, i) => ({
      id: i,
      name: `n${i}`,
    }));
    const c = compressed(compressToolResult(JSON.stringify(items), opts));
    expect(c.omittedLines).toBe(0);
    expect(c.omittedItems).toBe(592);
    expect(c.text.endsWith("\n")).toBe(false);
  });

  test("a number JSON cannot round-trip leaves the block whole", () => {
    const items = Array.from({ length: 1_000 }, (_, i) => ({
      id: i,
      name: `n${i}`,
    }));
    const text = JSON.stringify(items).replace(
      '{"id":7,',
      '{"id":90071992547409931,',
    );
    expect(text).toContain("90071992547409931");
    expect(compressToolResult(text, opts)).toEqual({
      kind: "unchanged",
      reason: "precision",
    });
  });

  test("a negative zero, which re-serialises as 0, leaves the block whole", () => {
    const items = Array.from({ length: 1_000 }, (_, i) => ({
      id: i,
      name: `n${i}`,
    }));
    const text = JSON.stringify(items).replace('{"id":7,', '{"id":-0.0,');
    expect(text).toContain("-0.0");
    expect(compressToolResult(text, opts)).toEqual({
      kind: "unchanged",
      reason: "precision",
    });
  });

  test("error items over the budget leave the block whole", () => {
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: i,
      error: i % 10 === 0 ? `boom ${"x".repeat(600)}` : null,
    }));
    expect(compressToolResult(JSON.stringify(items), opts)).toEqual({
      kind: "unchanged",
      reason: "errors_over_budget",
    });
  });

  test("no gain from json-array falls through to the line rules", () => {
    // 8 items, all kept; each pretty-prints over 40 lines of numbers, which dedupe folds.
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      values: Array.from({ length: 40 }, (_, k) => k),
    }));
    const c = compressed(
      compressToolResult(JSON.stringify(items, null, 2), opts),
    );
    expect(c.rule).not.toBe("json-array");
  });
});

describe("line rules", () => {
  test("a 2000-line test log keeps every error line and both ends", () => {
    const text = realisticTestLog();
    const c = compressed(compressToolResult(text, opts));
    expect(c.rule).toBe("dedupe+head-tail");
    const { body } = parts(c.text);
    const errors = text
      .split("\n")
      .filter((l) => /FAIL|AssertionError| × /.test(l));
    for (const e of errors) expect(body).toContain(e);
    expect(body.slice(0, 2)).toEqual(text.split("\n").slice(0, 2));
    expect(c.omittedItems).toBe(0);
    expect(c.charsOut * 100).toBeLessThanOrEqual(c.charsIn * 70);
  });

  test("Jest and pytest failure lines in the middle of a long log all survive", () => {
    const failures = [
      "  ✕ retries item 1 (12ms)",
      "  ✕ retries item 2 (13ms)",
      "  ✕ retries item 3 (14ms)",
      ">       assert total(order) == 81",
      "E       assert 90 == 81",
      "E       assert 91 == 81",
      "E       assert 92 == 81",
    ];
    const text = [...distinct(500), ...failures, ...distinct(500)].join("\n");
    const { body } = parts(compressed(compressToolResult(text, opts)).text);
    const at = body.indexOf(failures[0] ?? "");
    expect(body.slice(at, at + failures.length)).toEqual(failures);
  });

  test("no rule gains 30 %: unchanged", () => {
    const text = Array.from(
      { length: 100 },
      (_, i) => `${i % 2 ? "odd" : "even"} ${"y".repeat(100)} ${i}`,
    ).join("\n");
    expect(compressToolResult(text, opts)).toEqual({
      kind: "unchanged",
      reason: "no_gain",
    });
  });

  test("error lines over the budget with nothing folded: unchanged", () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `Error: ${i} ${"z".repeat(60)}`,
    ).join("\n");
    expect(compressToolResult(text, opts)).toEqual({
      kind: "unchanged",
      reason: "errors_over_budget",
    });
  });

  test("error lines over the budget: the dedupe-only body when it gains enough", () => {
    const errors = Array.from(
      { length: 300 },
      (_, i) => `Error: ${i} ${"z".repeat(60)}`,
    );
    const ticks = Array.from(
      { length: 3_000 },
      (_, i) => `tick ${i} of the clock`,
    );
    const c = compressed(
      compressToolResult([...ticks, ...errors].join("\n"), opts),
    );
    expect(c.rule).toBe("dedupe");
    const { body } = parts(c.text);
    expect(body.slice(0, 2)).toEqual([
      "tick 0 of the clock",
      "… ×2999 similar lines (L2–L3000)",
    ]);
    expect(body.slice(2)).toEqual(errors);
    expect(c.keptErrorLines).toBe(300);
    expect(c.omittedLines).toBe(2999);
  });

  test("error lines over the budget and a dedupe-only body without gain: unchanged", () => {
    const errors = Array.from(
      { length: 300 },
      (_, i) => `Error: ${i} ${"z".repeat(60)}`,
    );
    const ticks = Array.from({ length: 10 }, (_, i) => `tick ${i}`);
    expect(compressToolResult([...ticks, ...errors].join("\n"), opts)).toEqual({
      kind: "unchanged",
      reason: "errors_over_budget",
    });
  });

  test("CRLF in, CRLF out, the trailing line break kept", () => {
    const lines = [...distinct(300), "Error: in the middle", ...distinct(300)];
    const c = compressed(compressToolResult(`${lines.join("\r\n")}\r\n`, opts));
    expect(c.text.endsWith("\r\n")).toBe(true);
    expect(c.text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(parts(c.text).body).toContain("Error: in the middle");
  });

  test("no trailing line break in, none out", () => {
    const c = compressed(compressToolResult(distinct(400).join("\n"), opts));
    expect(c.text.endsWith("grep it.")).toBe(true);
  });

  test("a single 1 MB line is cut to 2 KB", () => {
    const text = "a".repeat(1024 * 1024);
    const c = compressed(compressToolResult(text, opts));
    expect(c.rule).toBe("head-tail");
    const { body, marker } = parts(c.text);
    expect(body).toEqual([
      `${"a".repeat(2048)}…[+${1024 * 1024 - 2048} chars]`,
    ]);
    expect(marker).toContain("1 lines, 1024 KB → 1 lines kept");
    expect(c.omittedLines).toBe(0);
  });

  test("a single 1 MB error line is over the budget", () => {
    expect(
      compressToolResult(`Error: ${"a".repeat(1024 * 1024)}`, opts),
    ).toEqual({
      kind: "unchanged",
      reason: "errors_over_budget",
    });
  });

  test("a surrogate pair at the cut is never split", () => {
    const text = `x${"😀".repeat(5_000)}`;
    const { body } = parts(compressed(compressToolResult(text, opts)).text);
    const kept = body[0]?.split("…[+")[0] ?? "";
    expect(kept.length).toBe(1 + 2 * 511); // 1 + 4 × 511 = 2045 bytes; one more is 2049
    expect(kept.at(-1)).toBe("\ude00");
  });
});
