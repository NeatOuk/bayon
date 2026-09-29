// A project's tier per step (048): `workspaces.plan_tier`, `build_tier`, `review_tier`,
// each NULL (inherit) or a tier, held to the tier set by 048's CHECKs. Read at spawn by
// bindingModelOn and shown by the API; written only through the API's doors (project-settings.ts,
// project-create.ts), Invariant 5.
import type { ModelStep, StepTiers } from "@bayon/core";
import { first, qb, type Internals } from "../connection.js";
import type { WorkspaceRow } from "../schema.js";

type StepColumns = Pick<
  WorkspaceRow,
  "plan_tier" | "build_tier" | "review_tier"
>;

/** The step and the project a session's tier may come from; either null: no project tier. */
export interface StepRef {
  readonly workspaceId: string | null;
  readonly step: ModelStep | null;
}

/** A workspace row's step tiers, as stored. */
export const stepTiersOf = (w: StepColumns): StepTiers => ({
  plan: w.plan_tier,
  build: w.build_tier,
  review: w.review_tier,
});

/** Step tiers as the workspace columns that hold them. */
export const stepTierColumns = (t: StepTiers): StepColumns => ({
  plan_tier: t.plan,
  build_tier: t.build,
  review_tier: t.review,
});

/**
 * The tier project `ref.workspaceId` names for step `ref.step`, inside a read; null when either is
 * null, the project does not exist, or it inherits.
 */
export function stepTierIn(ix: Internals, ref: StepRef): string | null {
  const { workspaceId, step } = ref;
  if (workspaceId === null || step === null) return null;
  const row = first(
    ix,
    qb
      .selectFrom("workspaces")
      .select(["plan_tier", "build_tier", "review_tier"])
      .where("id", "=", workspaceId),
  );
  return row === undefined ? null : stepTiersOf(row)[step];
}
