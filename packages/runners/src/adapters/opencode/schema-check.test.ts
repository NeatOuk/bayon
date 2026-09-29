import { REVIEW_OUTPUT_JSON_SCHEMA } from "@bayon/core";
import { describe, expect, test } from "vitest";
import { outputInstruction } from "./output.js";
import {
  checkValue,
  parseAnswer,
  unsupportedKeywords,
} from "./schema-check.js";

const REVIEW = {
  summary: "add() subtracts.",
  findings: [
    {
      severity: "major",
      summary: "add returns a - b",
      file: "add.js",
      line: 2,
      category: "correctness",
      detail_md: null,
    },
  ],
};

describe("the structured-output check (design §6)", () => {
  test("the review schema uses only keywords the check enforces", () => {
    expect(unsupportedKeywords(REVIEW_OUTPUT_JSON_SCHEMA)).toEqual([]);
  });

  test("a valid review passes; each kind of mistake is named", () => {
    expect(checkValue(REVIEW_OUTPUT_JSON_SCHEMA, REVIEW)).toEqual([]);
    expect(
      checkValue(REVIEW_OUTPUT_JSON_SCHEMA, { ...REVIEW, extra: 1 }),
    ).toEqual(["$: unexpected extra"]);
    expect(checkValue(REVIEW_OUTPUT_JSON_SCHEMA, { findings: [] })).toEqual([
      "$: missing summary",
    ]);
    const [finding] = REVIEW.findings;
    expect(
      checkValue(REVIEW_OUTPUT_JSON_SCHEMA, {
        ...REVIEW,
        findings: [{ ...finding, severity: "huge", line: "2" }],
      }),
    ).toEqual([
      '$.findings[0].severity: not one of ["blocker","major","minor","nit"]',
      "$.findings[0].line: expected number or null, got string",
    ]);
    expect(checkValue(REVIEW_OUTPUT_JSON_SCHEMA, [])).toEqual([
      "$: expected object, got array",
    ]);
  });

  test("the rest of the checked keywords", () => {
    expect(checkValue({ type: "integer" }, 1.5)).toHaveLength(1);
    expect(checkValue({ type: "number" }, 2)).toEqual([]);
    expect(checkValue({ const: "a" }, "b")).toHaveLength(1);
    expect(checkValue({ minLength: 2, maxLength: 3 }, "a")).toHaveLength(1);
    expect(checkValue({ minimum: 1, maximum: 2 }, 3)).toHaveLength(1);
    expect(checkValue({ minItems: 1 }, [])).toHaveLength(1);
    expect(
      checkValue({ maxItems: 1, items: { type: "string" } }, ["a", 1]),
    ).toHaveLength(2);
    expect(
      checkValue({ anyOf: [{ type: "string" }, { type: "null" }] }, null),
    ).toEqual([]);
    expect(
      checkValue({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1),
    ).toHaveLength(1);
    expect(
      checkValue({ allOf: [{ type: "object" }, { required: ["a"] }] }, {}),
    ).toHaveLength(1);
    expect(
      checkValue({ additionalProperties: { type: "string" } }, { a: 1 }),
    ).toHaveLength(1);
    expect(checkValue(false, 1)).toHaveLength(1);
    expect(checkValue(true, 1)).toEqual([]);
  });

  test("a schema with a keyword the check cannot enforce is reported, not half-checked", () => {
    expect(
      unsupportedKeywords({
        type: "object",
        properties: { a: { type: "string", pattern: "^x" } },
        items: { format: "uri" },
        anyOf: [{ $ref: "#/x" }],
      }),
    ).toEqual(["$ref", "format", "pattern"]);
    expect(unsupportedKeywords({ title: "t", description: "d" })).toEqual([]);
  });

  test("the answer may carry one surrounding code fence; anything else must be bare JSON", () => {
    expect(parseAnswer('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseAnswer('```json\n{"a":1}\n```')).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(parseAnswer("Here it is: {}")).toEqual({
      ok: false,
      value: undefined,
    });
  });

  test("the instruction heads with its version and carries the schema", () => {
    const text = outputInstruction({ type: "object" });
    expect(text.split("\n")[0]).toBe("[opencode-output/1]");
    expect(text).toContain('{"type":"object"}');
  });
});
