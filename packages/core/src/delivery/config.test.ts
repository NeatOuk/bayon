import { expect, test } from "vitest";
import { TICKET_STATUSES } from "../laws/statuses.js";
import {
  DELIVERABLE_STATUSES,
  DELIVERY_MODES,
  DELIVERY_MOMENTS,
  DELIVERY_STATUSES,
  NO_DELIVERY_CONFIG,
  deliveryDue,
  deliverySinceAfter,
  isDeliveryMode,
  isDeliveryMoment,
  opensPullRequests,
} from "./config.js";

// an earlier change spike §1.2: the moment is a set of statuses, not an edge. The table below is written out
// per status on purpose — a status added to §3.2 that ought to deliver has to be decided here, not
// inherited by an ordering trick.

test("every project starts delivering nothing", () => {
  expect(NO_DELIVERY_CONFIG).toEqual({
    mode: "none",
    when: "review_passed",
    close_on_merge: true,
  });
  expect(DELIVERY_MODES[0]).toBe("none");
  expect(DELIVERY_MOMENTS[0]).toBe("review_passed");
});

test("the modes and moments are recognised, and nothing else is", () => {
  expect(DELIVERY_MODES.every(isDeliveryMode)).toBe(true);
  expect(DELIVERY_MOMENTS.every(isDeliveryMoment)).toBe(true);
  expect(isDeliveryMode("pr")).toBe(false);
  expect(isDeliveryMoment("code_review")).toBe(false);
});

test("only pull_request opens pull requests", () => {
  expect(DELIVERY_MODES.filter(opensPullRequests)).toEqual(["pull_request"]);
});

const DUE = ["qa_harness", "qa_human", "done"];

test("review_passed is every status past code_review, and no other", () => {
  const due = TICKET_STATUSES.filter((s) => deliveryDue("review_passed", s));
  expect([...due]).toEqual(DUE);
});

test("done is done alone", () => {
  const due = TICKET_STATUSES.filter((s) => deliveryDue("done", s));
  expect([...due]).toEqual(["done"]);
});

test("work sent back is never due", () => {
  for (const status of ["review_fix", "rework", "code_review", "blocked"]) {
    expect(deliveryDue("review_passed", status)).toBe(false);
    expect(deliveryDue("done", status)).toBe(false);
  }
});

test("an unknown status is never due", () => {
  expect(deliveryDue("review_passed", "not_a_status")).toBe(false);
});

test("DELIVERABLE_STATUSES is every moment's set, deduped", () => {
  expect([...DELIVERABLE_STATUSES].toSorted()).toEqual([...DUE].toSorted());
  expect(Object.values(DELIVERY_STATUSES).flat()).toContain("done");
});

// when delivery was turned on, the mark only a later moment is delivered from.
const T1 = 1_000;
const T2 = 2_000;

test("turning delivery on marks now, and turning it on again marks anew", () => {
  expect(deliverySinceAfter("none", null, "push", T2)).toBe(T2);
  expect(deliverySinceAfter("none", null, "pull_request", T2)).toBe(T2);
  // A stale mark left on a project that delivers nothing never carries over.
  expect(deliverySinceAfter("none", T1, "pull_request", T2)).toBe(T2);
});

test("a change between two ways of delivering keeps the mark", () => {
  expect(deliverySinceAfter("push", T1, "pull_request", T2)).toBe(T1);
  expect(deliverySinceAfter("pull_request", T1, "push", T2)).toBe(T1);
  expect(deliverySinceAfter("push", T1, "push", T2)).toBe(T1);
});

test("turning delivery off clears the mark", () => {
  expect(deliverySinceAfter("push", T1, "none", T2)).toBeNull();
  expect(deliverySinceAfter("none", null, "none", T2)).toBeNull();
});

test("a delivering project no writer marked is marked now", () => {
  expect(deliverySinceAfter("push", null, "pull_request", T2)).toBe(T2);
});
