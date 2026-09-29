import { expect, test } from "vitest";
import {
  MODEL_STEPS,
  ModelStep,
  NO_STEP_TIERS,
  RUN_CLASS_STEP,
  StepTiers,
  changedSteps,
  sessionTier,
  stepOfRunClass,
  withStepTiers,
} from "./model-steps.js";
import { DEFAULT_RUN_CLASSES } from "./run-classes.js";

// A tier per step, per project: which run class is which step, and the order a session's
// tier is resolved in — its binding's, then its project's for its step, then its profile's.

test("sessionTier: the role binding's tier wins over the step's and the profile's", () => {
  expect(
    sessionTier({ binding: "cheap", step: "complex", profile: "standard" }),
  ).toBe("cheap");
  expect(sessionTier({ binding: "complex" })).toBe("complex");
});

test("sessionTier: with no binding tier, the project's step tier wins over the profile's", () => {
  expect(
    sessionTier({ binding: null, step: "complex", profile: "standard" }),
  ).toBe("complex");
  expect(sessionTier({ step: "cheap", profile: null })).toBe("cheap");
});

test("sessionTier: with neither, the profile's; with nothing set, null", () => {
  expect(sessionTier({ binding: null, step: null, profile: "standard" })).toBe(
    "standard",
  );
  expect(sessionTier({ profile: "cheap" })).toBe("cheap");
  expect(sessionTier({ binding: null, step: null, profile: null })).toBeNull();
  expect(sessionTier({})).toBeNull();
});

test("stepOfRunClass: spike plans; build, build_complex and fix build; review reviews", () => {
  expect(stepOfRunClass("spike")).toBe("plan");
  expect(stepOfRunClass("build")).toBe("build");
  expect(stepOfRunClass("build_complex")).toBe("build");
  expect(stepOfRunClass("fix")).toBe("build");
  expect(stepOfRunClass("review")).toBe("review");
});

test("stepOfRunClass: every other class has no step, and a prototype key is no class", () => {
  for (const name of ["pulse", "qa", "probe", "parity", "lint", "mine", ""]) {
    expect(stepOfRunClass(name), name).toBeNull();
  }
  for (const key of [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
  ]) {
    expect(stepOfRunClass(key), key).toBeNull();
  }
});

test("every mapped run class is a §8.4 class, and every step has one", () => {
  const known = new Set(DEFAULT_RUN_CLASSES.map((c) => c.name));
  for (const name of Object.keys(RUN_CLASS_STEP)) {
    expect(known.has(name), name).toBe(true);
  }
  expect(new Set(Object.values(RUN_CLASS_STEP))).toEqual(new Set(MODEL_STEPS));
  expect(ModelStep.options).toEqual([...MODEL_STEPS]);
});

test("StepTiers: a tier or null per step, nothing else", () => {
  expect(StepTiers.parse(NO_STEP_TIERS)).toEqual({
    plan: null,
    build: null,
    review: null,
  });
  expect(
    StepTiers.parse({ plan: "complex", build: "standard", review: null }),
  ).toEqual({ plan: "complex", build: "standard", review: null });
  expect(
    StepTiers.safeParse({ plan: "huge", build: null, review: null }).success,
  ).toBe(false);
  expect(StepTiers.safeParse({ plan: null, build: null }).success).toBe(false);
});

test("withStepTiers: the steps a patch names change, null inherits, the rest stay", () => {
  const current: StepTiers = { plan: "complex", build: "cheap", review: null };
  expect(withStepTiers(current, {})).toEqual(current);
  expect(
    withStepTiers(current, { build: "standard", review: "complex" }),
  ).toEqual({ plan: "complex", build: "standard", review: "complex" });
  expect(withStepTiers(current, { plan: null })).toEqual({
    plan: null,
    build: "cheap",
    review: null,
  });
});

test("changedSteps: the steps whose tier differs, in step order", () => {
  expect(changedSteps(NO_STEP_TIERS, NO_STEP_TIERS)).toEqual([]);
  expect(
    changedSteps(NO_STEP_TIERS, {
      plan: "complex",
      build: null,
      review: "complex",
    }),
  ).toEqual(["plan", "review"]);
  expect(
    changedSteps(
      { plan: null, build: "cheap", review: null },
      { plan: null, build: "standard", review: null },
    ),
  ).toEqual(["build"]);
});
