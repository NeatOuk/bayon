import { describe, expect, test } from "vitest";
import {
  REVIEW_OUTPUT_JSON_SCHEMA,
  parseHeuristicFindings,
  parseReviewOutput,
  parseSchemaFindings,
  type ReviewFinding,
  type ReviewOutput,
} from "./findings.js";

const finding = (o: Partial<ReviewFinding> = {}): ReviewFinding => ({
  severity: "major",
  summary: "the transaction is never committed",
  file: "src/db/repo.ts",
  line: 42,
  category: "correctness",
  detail_md: null,
  ...o,
});
const output = (findings: ReviewFinding[]): ReviewOutput => ({
  summary: "one issue",
  findings,
});

describe("REVIEW_OUTPUT_JSON_SCHEMA: for strict structured-output modes", () => {
  test("every object is closed and lists every key as required", () => {
    expect(REVIEW_OUTPUT_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["summary", "findings"],
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "severity",
              "summary",
              "file",
              "line",
              "category",
              "detail_md",
            ],
            properties: {
              severity: { enum: ["blocker", "major", "minor", "nit"] },
            },
          },
        },
      },
    });
  });

  test("it is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA))).toEqual(
      REVIEW_OUTPUT_JSON_SCHEMA,
    );
  });
});

describe("parseSchemaFindings: output produced against the schema", () => {
  test("well-formed output parses, marked schema", () => {
    const text = JSON.stringify(
      output([finding(), finding({ severity: "nit", file: null, line: null })]),
    );
    expect(parseSchemaFindings(text)).toEqual({
      ok: true,
      value: {
        findings: [
          finding(),
          finding({ severity: "nit", file: null, line: null }),
        ],
        parse: "schema",
      },
    });
  });

  test("a clean review is zero findings", () => {
    expect(parseSchemaFindings('{"summary":"clean","findings":[]}')).toEqual({
      ok: true,
      value: { findings: [], parse: "schema" },
    });
  });

  test("text that is not JSON is a validation error", () => {
    expect(parseSchemaFindings("LGTM")).toMatchObject({
      ok: false,
      error: { class: "validation", message: "review output is not JSON" },
    });
  });

  test.each<[string, unknown]>([
    [
      "an unknown severity",
      output([finding({ severity: "critical" as never })]),
    ],
    ["a blank summary", output([finding({ summary: "  " })])],
    ["line 0", output([finding({ line: 0 })])],
    ["a fractional line", output([finding({ line: 1.5 })])],
    ["a key outside the schema", { ...output([]), verdict: "pass" }],
    ["a missing key", { summary: "x" }],
  ])("JSON with %s fails the findings schema", (_, value) => {
    expect(parseSchemaFindings(JSON.stringify(value))).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: expect.stringContaining("fails the findings schema"),
      },
    });
  });
});

describe("parseHeuristicFindings: a runner without outputSchema", () => {
  test("well-formed: a fenced ReviewOutput in prose", () => {
    const text = [
      "Here is my review.",
      "```json",
      JSON.stringify(output([finding()])),
      "```",
      "Thanks!",
    ].join("\n");
    expect(parseHeuristicFindings(text)).toEqual({
      findings: [finding()],
      parse: "heuristic",
    });
  });

  test("well-formed: a bare ReviewOutput in prose", () => {
    const text = `Review: ${JSON.stringify(output([finding({ severity: "blocker" })]))} end`;
    expect(parseHeuristicFindings(text).findings).toEqual([
      finding({ severity: "blocker" }),
    ]);
  });

  test("a fenced block that is not a review is skipped for the next one", () => {
    const text = [
      "```json",
      '{"not":"a review"}',
      "```",
      "```",
      JSON.stringify(output([finding()])),
      "```",
    ].join("\n");
    expect(parseHeuristicFindings(text).findings).toEqual([finding()]);
  });

  test("messy: severity-tagged lines in every style, prose left alone", () => {
    const text = [
      "Overall this looks reasonable. Minor improvements could be made to naming.",
      "",
      "Findings:",
      "- [major] src/db/repo.ts:42 — the transaction is never committed",
      "1. **Blocker**: `packages/api/x.ts:7` SQL built by string concatenation",
      "* (nit) README.md trailing whitespace",
      "MINOR: error messages are inconsistent",
      "- **Major:** apps/web/a.tsx: missing key prop  ",
      "Severity summary: 1 blocker, 2 major.",
      "A stray {not json} brace pair.",
    ].join("\r\n");
    const bare = { category: null, detail_md: null };
    expect(parseHeuristicFindings(text)).toEqual({
      parse: "heuristic",
      findings: [
        {
          ...bare,
          severity: "major",
          file: "src/db/repo.ts",
          line: 42,
          summary: "the transaction is never committed",
        },
        {
          ...bare,
          severity: "blocker",
          file: "packages/api/x.ts",
          line: 7,
          summary: "SQL built by string concatenation",
        },
        {
          ...bare,
          severity: "nit",
          file: "README.md",
          line: null,
          summary: "trailing whitespace",
        },
        {
          ...bare,
          severity: "minor",
          file: null,
          line: null,
          summary: "error messages are inconsistent",
        },
        {
          ...bare,
          severity: "major",
          file: "apps/web/a.tsx",
          line: null,
          summary: "missing key prop",
        },
      ],
    });
  });

  test.each([
    ["empty", ""],
    ["whitespace", "  \n\t\n"],
    ["prose only", "Looks good to me. No issues found."],
    ["braces out of order", "} nothing here {"],
  ])("%s output holds no findings", (_, text) => {
    expect(parseHeuristicFindings(text)).toEqual({
      findings: [],
      parse: "heuristic",
    });
  });
});

describe("parseReviewOutput: by the runner's outputSchema capability", () => {
  const text = "- [minor] naming";

  test("with outputSchema, strictly", () => {
    expect(parseReviewOutput(text, true)).toMatchObject({ ok: false });
  });

  test("without it, heuristically", () => {
    expect(parseReviewOutput(text, false)).toEqual({
      ok: true,
      value: {
        parse: "heuristic",
        findings: [
          {
            severity: "minor",
            summary: "naming",
            file: null,
            line: null,
            category: null,
            detail_md: null,
          },
        ],
      },
    });
  });
});
