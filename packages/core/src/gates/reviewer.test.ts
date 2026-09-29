import { describe, expect, test } from "vitest";
import {
  pickReviewer,
  type PickReviewerInput,
  type ReviewerBinding,
  type ReviewerPick,
  type ReviewerRunner,
} from "./reviewer.js";

/** A certified, gate-eligible, enabled runner unless `o` says otherwise. */
const runner = (
  id: string,
  o: Partial<ReviewerRunner> = {},
): ReviewerRunner => ({
  id,
  enabled: 1,
  gate_eligible: 1,
  conformance_passed_at: 1_700_000_000_000,
  ...o,
});
const uncertified = (id: string) => runner(id, { conformance_passed_at: null });
const bind = (
  runner_id: string,
  fallback_runner_id: string | null = null,
): ReviewerBinding => ({ runner_id, fallback_runner_id });
const pick = (
  runnerId: string,
  fallbackFrom: string | null = null,
  singleRunnerReview = false,
): ReviewerPick => ({ runnerId, fallbackFrom, singleRunnerReview });

const input = (o: Partial<PickReviewerInput>): PickReviewerInput => ({
  builderRunnerId: "a",
  binding: null,
  runners: [runner("a"), runner("b")],
  requireDistinct: true,
  ...o,
});

describe("pickReviewer (§9.8): distinct, fallback, single-runner, uncertified", () => {
  test.each<[string, Partial<PickReviewerInput>, ReviewerPick]>([
    [
      "distinct: the bound runner, which is not the builder's",
      { binding: bind("b") },
      pick("b"),
    ],
    [
      "fallback: the bound runner is uncertified",
      {
        binding: bind("b", "c"),
        runners: [runner("a"), uncertified("b"), runner("c")],
      },
      pick("c", "b"),
    ],
    [
      "fallback: the bound runner is disabled",
      {
        binding: bind("b", "c"),
        runners: [runner("b", { enabled: 0 }), runner("c")],
      },
      pick("c", "b"),
    ],
    [
      "fallback: the bound runner is not gate-eligible",
      {
        binding: bind("b", "c"),
        runners: [runner("b", { gate_eligible: 0 }), runner("c")],
      },
      pick("c", "b"),
    ],
    [
      "fallback: the bound runner has no row",
      { binding: bind("x", "b") },
      pick("b", "x"),
    ],
    [
      "fallback: the bound runner is the builder's, and distinctness is required",
      { binding: bind("a", "b") },
      pick("b", "a"),
    ],
    [
      "single-runner: a same-runner binding with no fallback runs anyway, flagged",
      { binding: bind("a") },
      pick("a", null, true),
    ],
    [
      "single-runner: a same-runner binding whose fallback is uncertified",
      { binding: bind("a", "b"), runners: [runner("a"), uncertified("b")] },
      pick("a", null, true),
    ],
    [
      "single-runner: the fallback is the builder's own runner",
      { binding: bind("b", "a"), runners: [runner("a"), uncertified("b")] },
      pick("a", "b", true),
    ],
    [
      "single-runner: unbound, and only the builder's runner is certified",
      { runners: [runner("a"), uncertified("b")] },
      pick("a", null, true),
    ],
    [
      "unbound: the first eligible runner by id that is not the builder's",
      {
        builderRunnerId: "b",
        runners: [runner("c"), runner("b"), runner("a")],
      },
      pick("a"),
    ],
    [
      "distinctness not required: the bound runner, even the builder's, flagged",
      { binding: bind("a", "b"), requireDistinct: false },
      pick("a", null, true),
    ],
    [
      "distinctness not required, unbound: the first eligible runner by id",
      { requireDistinct: false, runners: [runner("b"), runner("a")] },
      pick("a", null, true),
    ],
  ])("%s", (_, o, expected) => {
    expect(pickReviewer(input(o))).toEqual(expected);
  });

  test.each<[string, Partial<PickReviewerInput>]>([
    ["no runners at all", { runners: [] }],
    [
      "every runner uncertified, disabled or not gate-eligible",
      {
        runners: [
          uncertified("a"),
          runner("b", { enabled: 0 }),
          runner("c", { gate_eligible: 0 }),
        ],
      },
    ],
    [
      "the binding names only ineligible runners: an eligible runner it does not name is not taken",
      {
        binding: bind("b", "c"),
        runners: [runner("a"), uncertified("b"), uncertified("c"), runner("d")],
      },
    ],
  ])("no candidate: %s", (_, o) => {
    expect(pickReviewer(input(o))).toBeNull();
  });
});

// a project's own reviewer runners, in the order the gate pick names them (the binding's
// first), in place of the binding's pair — so a project reviewed on a runner the binding does not
// name still gets its review, and a runner outside the order is never taken.
describe("pickReviewer with an explicit order (a project's reviewer runners)", () => {
  test.each<[string, Partial<PickReviewerInput>, ReviewerPick]>([
    [
      "the first runner in the order that is distinct from the builder's",
      {
        binding: bind("x"),
        order: ["a", "c"],
        runners: [runner("a"), runner("c")],
      },
      pick("c", "a"),
    ],
    [
      "a runner the binding does not name is taken when the order names it",
      { binding: bind("b"), order: ["c"], runners: [runner("b"), runner("c")] },
      pick("c"),
    ],
    [
      "the order's first runner uncertified: the next one, recorded as its fallback",
      {
        order: ["b", "c"],
        runners: [uncertified("b"), runner("c")],
      },
      pick("c", "b"),
    ],
    [
      "only the builder's runner in the order: it reviews, flagged",
      { order: ["a"], runners: [runner("a"), runner("b")] },
      pick("a", null, true),
    ],
  ])("%s", (_, o, expected) => {
    expect(pickReviewer(input(o))).toEqual(expected);
  });

  test("an empty order, or one naming only ineligible runners, is no candidate", () => {
    expect(pickReviewer(input({ order: [] }))).toBeNull();
    expect(
      pickReviewer(
        input({ order: ["c"], runners: [runner("b"), uncertified("c")] }),
      ),
    ).toBeNull();
  });
});
