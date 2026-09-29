import { describe, expect, test } from "vitest";
import { canonicalJson } from "../hash/canonical-json.js";
import { sha256Hex } from "../hash/hashes.js";
import { ComplexityRubric, DEFAULT_COMPLEXITY_RUBRIC } from "./rubric.js";
import { complexityColumns, scoreComplexity } from "./score.js";

// §8.8's rubric fixtures: the score, the tier and non_trivial from declared facts (amendment 11).

const score = (
  facts: Record<string, boolean>,
  rubric = DEFAULT_COMPLEXITY_RUBRIC,
) => {
  const scored = scoreComplexity(facts, rubric);
  if (!scored.ok) throw new Error(scored.error.message);
  return scored.value;
};

describe("scoreComplexity with the default rubric", () => {
  test.each<[string, Record<string, boolean>, number, string]>([
    ["no facts", {}, 0, "cheap"],
    ["pure docs", { cosmetic_only: true }, -3, "cheap"],
    [
      "a public contract (the standard edge)",
      { public_contract: true },
      2,
      "standard",
    ],
    [
      "migration + public contract",
      { schema_migration: true, public_contract: true },
      5,
      "standard",
    ],
    [
      "migration + concurrency (the complex edge)",
      { schema_migration: true, concurrency: true },
      6,
      "complex",
    ],
    [
      "sensitive data + cosmetic",
      { sensitive_data: true, cosmetic_only: true },
      0,
      "cheap",
    ],
    ["a false fact counts nothing", { concurrency: false }, 0, "cheap"],
    [
      "everything",
      Object.fromEntries(
        Object.keys(DEFAULT_COMPLEXITY_RUBRIC.factors).map((k) => [k, true]),
      ),
      15,
      "complex",
    ],
  ])("%s → %i %s", (_name, facts, expected, tier) => {
    const result = score(facts);
    expect(result.score).toBe(expected);
    expect(result.tier).toBe(tier);
    expect(result.non_trivial).toBe(tier === "complex");
  });

  test("contributions list only the true facts", () => {
    expect(
      score({ concurrency: true, cosmetic_only: false }).contributions,
    ).toEqual({
      concurrency: 3,
    });
  });
});

describe("the rubric is the operator's", () => {
  test("a tuned rubric changes the tier", () => {
    const strict = ComplexityRubric.parse({
      ...DEFAULT_COMPLEXITY_RUBRIC,
      tiers: { complex: 2, standard: 1 },
    });
    expect(score({ public_contract: true }, strict).tier).toBe("complex");
  });

  test("an unknown fact is a validation error naming the known ones", () => {
    const result = scoreComplexity({ vibes: true }, DEFAULT_COMPLEXITY_RUBRIC);
    expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(result.ok ? "" : result.error.message).toContain(
      "unknown complexity fact(s): vibes",
    );
    expect(result.ok ? "" : result.error.message).toContain("concurrency");
  });

  test.each([
    ["complex not above standard", { tiers: { complex: 2, standard: 2 } }],
    ["no factors", { factors: {} }],
    ["a bad factor name", { factors: { "Bad Name": 1 } }],
    ["a fractional weight", { factors: { concurrency: 1.5 } }],
  ])("%s is rejected", (_name, change) => {
    expect(
      ComplexityRubric.safeParse({ ...DEFAULT_COMPLEXITY_RUBRIC, ...change })
        .success,
    ).toBe(false);
  });

  test("the default rubric is §8.8's table", () => {
    expect(ComplexityRubric.parse(DEFAULT_COMPLEXITY_RUBRIC)).toEqual(
      DEFAULT_COMPLEXITY_RUBRIC,
    );
    expect(DEFAULT_COMPLEXITY_RUBRIC.tiers).toEqual({
      complex: 6,
      standard: 2,
    });
  });
});

describe("complexityColumns", () => {
  test("stores the score, the tier, non_trivial and the auditable factors", async () => {
    const columns = await complexityColumns(
      { schema_migration: true, concurrency: true, cosmetic_only: false },
      DEFAULT_COMPLEXITY_RUBRIC,
    );
    const rubric_hash = await sha256Hex(
      canonicalJson(DEFAULT_COMPLEXITY_RUBRIC),
    );
    expect(columns).toEqual({
      ok: true,
      value: {
        complexity_score: 6,
        complexity_tier: "complex",
        non_trivial: 1,
        complexity_factors_json: canonicalJson({
          facts: {
            concurrency: true,
            cosmetic_only: false,
            schema_migration: true,
          },
          contributions: { concurrency: 3, schema_migration: 3 },
          rubric_hash,
        }),
      },
    });
  });

  test("the rubric hash ignores key order", async () => {
    const reordered = ComplexityRubric.parse({
      tiers: { standard: 2, complex: 6 },
      factors: Object.fromEntries(
        Object.entries(DEFAULT_COMPLEXITY_RUBRIC.factors).toReversed(),
      ),
      v: 1,
    });
    const a = await complexityColumns({}, DEFAULT_COMPLEXITY_RUBRIC);
    const b = await complexityColumns({}, reordered);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      ok: true,
      value: { non_trivial: 0, complexity_tier: "cheap" },
    });
  });

  test("an unknown fact scores nothing", async () => {
    expect(
      await complexityColumns({ vibes: true }, DEFAULT_COMPLEXITY_RUBRIC),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });
});
