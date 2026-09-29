import { z } from "zod";
import { ModelTier } from "./run-classes.js";

// A model tier per step of a ticket's work, per project (§8.4, §9.8). A step is a group
// of run classes: planning (`spike`), building (`build`, `build_complex`, `fix`) and reviewing
// (`review`, which every LLM gate's session runs). A project may name a tier for each step; null
// inherits, which is what every session did before. Which run class is which step is data, here.

export const MODEL_STEPS = ["plan", "build", "review"] as const;

/** A step a project may give its own tier. */
export const ModelStep = z.enum(MODEL_STEPS);
export type ModelStep = z.infer<typeof ModelStep>;

/**
 * The §8.4 run classes that are a step. A class not listed — pulse, qa, probe, a script job's, an
 * operator's own — has no step, and so no project tier: its session inherits.
 */
export const RUN_CLASS_STEP: Readonly<Record<string, ModelStep>> =
  Object.freeze({
    spike: "plan",
    build: "build",
    build_complex: "build",
    fix: "build",
    review: "review",
  });

const STEP_OF = new Map(Object.entries(RUN_CLASS_STEP));

/** The step a run class is, or null when it is none. Only the map's own keys count. */
export const stepOfRunClass = (runClass: string): ModelStep | null =>
  STEP_OF.get(runClass) ?? null;

/** A project's tier for each step; null inherits (`workspaces.plan_tier`, … — migration 048). */
export const StepTiers = z.object({
  plan: ModelTier.nullable(),
  build: ModelTier.nullable(),
  review: ModelTier.nullable(),
});
export type StepTiers = z.infer<typeof StepTiers>;

/** A change to some of a project's step tiers: a step absent keeps its tier, null inherits. */
export type StepTiersPatch = Partial<StepTiers>;

/** No step names a tier: every session inherits. */
export const NO_STEP_TIERS: StepTiers = Object.freeze({
  plan: null,
  build: null,
  review: null,
});

/** `current` with the steps `patch` names set as it says. */
export const withStepTiers = (
  current: StepTiers,
  patch: StepTiersPatch,
): StepTiers => ({
  plan: patch.plan === undefined ? current.plan : patch.plan,
  build: patch.build === undefined ? current.build : patch.build,
  review: patch.review === undefined ? current.review : patch.review,
});

/** The steps whose tier differs between `a` and `b`, in MODEL_STEPS order. */
export const changedSteps = (a: StepTiers, b: StepTiers): ModelStep[] =>
  MODEL_STEPS.filter((step) => a[step] !== b[step]);

/**
 * The tier a session runs (§9.8) — the first that is set, in this order:
 *
 * 1. its role binding's `model_tier`: the operator's explicit per-role choice;
 * 2. its project's tier for the step its run class is;
 * 3. its profile's `model_tier`.
 *
 * Null when none is (no binding tier, no step tier, no profile for the runner). What the spawn runs
 * and what the gate pick checks certification on both come from this, through one db read.
 */
export const sessionTier = (tiers: {
  readonly binding?: string | null;
  readonly step?: string | null;
  readonly profile?: string | null;
}): string | null => tiers.binding ?? tiers.step ?? tiers.profile ?? null;
