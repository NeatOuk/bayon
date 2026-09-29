import { describe, expect, test } from "vitest";
import {
  dedupe,
  lineRules,
  type LinesBody,
  type LinesVerdict,
} from "./lines.js";

/** Consecutive lines that never fold: two templates, alternating. */
const distinct = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) =>
    (from + i) % 2 === 0 ? `even row ${from + i}` : `odd row ${from + i}`,
  );

function body(v: LinesVerdict): LinesBody {
  if (v.kind !== "body") throw new Error(`expected a body, got ${v.kind}`);
  return v;
}

describe("dedupe", () => {
  const line = (no: number, text: string, error = false) => ({
    kind: "line",
    no,
    text,
    error,
  });

  test("nothing in, nothing out", () => expect(dedupe([])).toEqual([]));

  test("a run of 3 similar lines keeps its first and folds the rest", () => {
    expect(dedupe(["a 1", "a 22", "a 333"])).toEqual([
      line(1, "a 1"),
      { kind: "fold", from: 2, to: 3 },
    ]);
  });

  test("a run of 2 is kept whole", () => {
    expect(dedupe(["a 1", "a 2", "b"])).toEqual([
      line(1, "a 1"),
      line(2, "a 2"),
      line(3, "b"),
    ]);
  });

  test("a digit run reads 0, so item 9 and item 10 are similar", () => {
    expect(dedupe(["item 9", "item 10", "item 11"])).toHaveLength(2);
  });

  test("error lines are never folded and break a run", () => {
    expect(
      dedupe(["a 1", "Error: 2", "a 3", "a 4", "a 5", "Error: 6", "Error: 7"]),
    ).toEqual([
      line(1, "a 1"),
      line(2, "Error: 2", true),
      line(3, "a 3"),
      { kind: "fold", from: 4, to: 5 },
      line(6, "Error: 6", true),
      line(7, "Error: 7", true),
    ]);
  });

  test.each([
    [
      "Jest",
      [
        "✕ retries item 1 (12ms)",
        "✕ retries item 2 (13ms)",
        "✕ retries item 3 (14ms)",
      ],
    ],
    [
      "pytest",
      [
        "E       assert 90 == 81",
        "E       assert 91 == 81",
        "E       assert 92 == 81",
      ],
    ],
  ])(
    "%s failure lines differing only in digits are never folded",
    (_, lines) => {
      expect(dedupe(lines)).toEqual(
        lines.map((text, i) => line(i + 1, text, true)),
      );
    },
  );

  test("different lines stay", () => {
    expect(dedupe(["a", "b", "c"])).toHaveLength(3);
  });
});

describe("lineRules", () => {
  test("dedupe alone when it gets under the threshold", () => {
    const lines = [
      "start",
      ...Array.from(
        { length: 400 },
        (_, i) => `GET /items/${i} 200 in ${i % 7}ms`,
      ),
      "Error: one failed",
      "end",
    ];
    const v = body(lineRules(lines));
    expect(v).toEqual({
      kind: "body",
      rule: "dedupe",
      lines: [
        "start",
        "GET /items/0 200 in 0ms",
        "… ×399 similar lines (L3–L401)",
        "Error: one failed",
        "end",
      ],
      keptLines: 4,
      errorLines: 1,
    });
  });

  test("head-tail alone when nothing folds", () => {
    const v = body(lineRules(distinct(0, 300)));
    expect(v.rule).toBe("head-tail");
    expect(v.lines).toEqual([
      ...distinct(0, 60),
      "… 180 lines omitted (L61–L240)",
      ...distinct(240, 60),
    ]);
    expect(v.keptLines).toBe(120);
  });

  test("dedupe then head-tail; a fold opens one gap and another closes it", () => {
    const rep = (from: number) =>
      Array.from({ length: 5 }, (_, i) => `rep ${from + i}`);
    const lines = [
      ...distinct(1, 59), // lines 1–59
      ...rep(60), // 60–64: line 60 kept in the head, 61–64 folded
      ...distinct(65, 100), // 65–164
      ...rep(165), // 165–169
      ...distinct(170, 60), // 170–229: the tail
    ];
    const v = body(lineRules(lines));
    expect(v.rule).toBe("dedupe+head-tail");
    expect(v.lines).toEqual([
      ...distinct(1, 59),
      "rep 60",
      "… 109 lines omitted (L61–L169)",
      ...distinct(170, 60),
    ]);
    expect(v.keptLines).toBe(120);
  });

  test("an error line keeps up to 30 continuation lines, then the gap resumes", () => {
    const trace = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? `    at-ish even ${i}` : `    at-ish odd ${i}`,
    );
    const lines = [
      ...distinct(0, 150),
      "TypeError: x is undefined",
      ...trace,
      ...distinct(191, 150),
    ];
    const v = body(lineRules(lines));
    expect(v.lines).toEqual([
      ...distinct(0, 60),
      "… 90 lines omitted (L61–L150)",
      "TypeError: x is undefined",
      ...trace.slice(0, 30),
      "… 100 lines omitted (L182–L281)",
      ...distinct(281, 60),
    ]);
    expect(v.errorLines).toBe(1);
    expect(v.keptLines).toBe(151);
  });

  test("a fold inside a trace continues it", () => {
    const trace = Array.from({ length: 40 }, (_, i) => `    same frame ${i}`);
    const lines = [
      ...distinct(0, 150),
      "Error: x",
      ...trace,
      ...distinct(191, 150),
    ];
    const v = body(lineRules(lines));
    const at = v.lines.indexOf("Error: x");
    expect(v.lines.slice(at, at + 4)).toEqual([
      "Error: x",
      "    same frame 0",
      "… ×39 similar lines (L153–L191)",
      "… 90 lines omitted (L192–L281)",
    ]);
  });

  test("a lone line between kept ones is kept: its gap line would cost as much", () => {
    const lines = [...distinct(0, 61), "Error: x", ...distinct(62, 238)];
    expect(body(lineRules(lines)).lines).toEqual([
      ...distinct(0, 61),
      "Error: x",
      "… 178 lines omitted (L63–L240)",
      ...distinct(240, 60),
    ]);
  });

  test("a trace ends at its first line that is not a continuation", () => {
    const lines = [
      ...distinct(0, 100),
      "FAIL src/a.test.ts",
      "at unindented (a.ts:1:1)",
      "\tindented with a tab",
      "not indented",
      "  indented again, but after the end",
      ...distinct(105, 100),
    ];
    const v = body(lineRules(lines));
    const at = v.lines.indexOf("FAIL src/a.test.ts");
    expect(v.lines.slice(at, at + 4)).toEqual([
      "FAIL src/a.test.ts",
      "at unindented (a.ts:1:1)",
      "\tindented with a tab",
      "… 42 lines omitted (L104–L145)",
    ]);
  });

  test("a long line is cut in head-tail, an error line never is", () => {
    const long = "x".repeat(5_000);
    const longError = `Error: ${"y".repeat(5_000)}`;
    const v = body(lineRules([long, longError, ...distinct(2, 300)]));
    expect(v.lines[0]).toBe(`${"x".repeat(2048)}…[+2952 chars]`);
    expect(v.lines[1]).toBe(longError);
  });

  test("dedupe keeps long lines whole", () => {
    const long = "x".repeat(3_000);
    const v = body(
      lineRules([long, ...Array.from({ length: 300 }, () => "same")]),
    );
    expect(v.rule).toBe("dedupe");
    expect(v.lines[0]).toBe(long);
  });

  test("error lines over 16 KB: head-tail declines, with no fallback when nothing folded", () => {
    const errors = Array.from(
      { length: 400 },
      (_, i) => `Error: ${i} ${"z".repeat(40)}`,
    );
    expect(lineRules([...errors, ...distinct(0, 100)])).toEqual({
      kind: "decline",
      reason: "errors_over_budget",
      fallback: null,
    });
  });

  test("error lines over 16 KB with folds: the dedupe-only body is the fallback", () => {
    const errors = Array.from(
      { length: 400 },
      (_, i) => `Error: ${i} ${"z".repeat(40)}`,
    );
    const same = Array.from({ length: 50 }, (_, i) => `tick ${i}`);
    const v = lineRules([...same, ...errors]);
    expect(v.kind).toBe("decline");
    if (v.kind !== "decline") return;
    expect(v.fallback?.rule).toBe("dedupe");
    expect(v.fallback?.lines.slice(0, 3)).toEqual([
      "tick 0",
      "… ×49 similar lines (L2–L50)",
      errors[0],
    ]);
    expect(v.fallback?.errorLines).toBe(400);
  });
});
