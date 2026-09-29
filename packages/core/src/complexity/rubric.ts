import { z } from "zod";

// §8.8's routing rubric, as operator config (`settings.complexity.rubric`): points per declared
// fact, and the score at which a ticket becomes standard or complex.

const FactorName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "factor names are snake_case");

export const ComplexityRubric = z.object({
  v: z.literal(1),
  factors: z
    .record(FactorName, z.int())
    .refine(
      (f) => Object.keys(f).length > 0,
      "a rubric needs at least one factor",
    ),
  tiers: z
    .object({ complex: z.int(), standard: z.int() })
    .refine(
      (t) => t.complex > t.standard,
      "tiers.complex must be above tiers.standard",
    ),
});
export type ComplexityRubric = z.infer<typeof ComplexityRubric>;

/** §8.8's table, row for row. */
export const DEFAULT_COMPLEXITY_RUBRIC: ComplexityRubric = Object.freeze({
  v: 1 as const,
  factors: Object.freeze({
    sensitive_data: 3, // touches money/payments, auth, or PII
    concurrency: 3, // concurrency, transactions, or idempotency
    schema_migration: 3, // schema migration or data backfill
    public_contract: 2, // public API / contract change
    large_change: 2, // > 5 files or > 300 LOC estimated
    multi_repo: 2, // multi-repo / submodule change
    security_dependency: 3, // security-sensitive dependency or crypto
    cosmetic_only: -3, // pure docs, copy, config, or cosmetic
  }),
  tiers: Object.freeze({ complex: 6, standard: 2 }),
});
