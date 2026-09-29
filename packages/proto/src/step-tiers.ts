import { ModelTier } from "@bayon/core";
import { z } from "zod";

// A project's tier per step on the wire: the view is core's StepTiers (each step a tier
// or null, inherit); a write names only the steps it changes. Steps and tiers are core's words, never
// a runner's or a model's (Invariant 1).

/** `POST /projects`' `step_tiers`: the steps it names, each a tier or null (inherit). */
export const StepTiersInput = z.strictObject({
  plan: ModelTier.nullable().optional(),
  build: ModelTier.nullable().optional(),
  review: ModelTier.nullable().optional(),
});
export type StepTiersInput = z.infer<typeof StepTiersInput>;

/** `PATCH /projects/:id`'s `step_tiers`: as StepTiersInput, naming at least one step. */
export const StepTiersPatch = StepTiersInput.refine(
  (patch) => Object.keys(patch).length > 0,
  "step_tiers names at least one step: plan, build or review",
);
export type StepTiersPatch = z.infer<typeof StepTiersPatch>;
