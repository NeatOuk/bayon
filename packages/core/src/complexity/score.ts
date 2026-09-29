import { z } from "zod";
import { err, ok, type Result } from "../errors.js";
import { canonicalJson } from "../hash/canonical-json.js";
import { sha256Hex } from "../hash/hashes.js";
import type { ModelTier } from "../run-classes.js";
import type { ComplexityRubric } from "./rubric.js";

// Deterministic complexity (§8.8) over facts declared on create or update (amendment 11), never a
// judgement call: same facts and rubric, same score, and the stored factors say why.

/** Facts a ticket declares, keyed by rubric factor. */
export const ComplexityFacts = z.record(z.string().min(1), z.boolean());
export type ComplexityFacts = z.infer<typeof ComplexityFacts>;

export interface ComplexityScore {
  readonly score: number;
  readonly tier: ModelTier;
  /** `complex` sets it, and it is what forces plan review and ce_review. */
  readonly non_trivial: boolean;
  /** The points each true fact added. */
  readonly contributions: Readonly<Record<string, number>>;
}

export function scoreComplexity(
  facts: Readonly<ComplexityFacts>,
  rubric: ComplexityRubric,
): Result<ComplexityScore> {
  const unknown = Object.keys(facts).filter(
    (key) => !Object.hasOwn(rubric.factors, key),
  );
  if (unknown.length > 0) {
    return err({
      class: "validation",
      message: `unknown complexity fact(s): ${unknown.join(", ")}; the rubric has ${Object.keys(rubric.factors).join(", ")}`,
      retryable: false,
    });
  }
  const contributions = Object.fromEntries(
    Object.entries(rubric.factors).filter(([key]) => facts[key] === true),
  );
  const score = Object.values(contributions).reduce(
    (sum, points) => sum + points,
    0,
  );
  const tier: ModelTier =
    score >= rubric.tiers.complex
      ? "complex"
      : score >= rubric.tiers.standard
        ? "standard"
        : "cheap";
  return ok({ score, tier, non_trivial: tier === "complex", contributions });
}

/** The ticket columns a score fills. */
export interface ComplexityColumns {
  readonly complexity_score: number;
  readonly complexity_tier: ModelTier;
  readonly non_trivial: 0 | 1;
  /** canonicalJson({facts, contributions, rubric_hash}): auditable after the fact. */
  readonly complexity_factors_json: string;
}

export async function complexityColumns(
  facts: Readonly<ComplexityFacts>,
  rubric: ComplexityRubric,
): Promise<Result<ComplexityColumns>> {
  const scored = scoreComplexity(facts, rubric);
  if (!scored.ok) return scored;
  const { score, tier, non_trivial, contributions } = scored.value;
  const rubric_hash = await sha256Hex(canonicalJson(rubric));
  return ok({
    complexity_score: score,
    complexity_tier: tier,
    non_trivial: non_trivial ? 1 : 0,
    complexity_factors_json: canonicalJson({
      facts,
      contributions,
      rubric_hash,
    }),
  });
}
