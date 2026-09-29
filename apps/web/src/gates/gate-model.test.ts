import { expect, test } from "vitest";
import {
  failureDetail,
  failureNote,
  gateGroups,
  gateName,
  retriedAttempt,
  reviewerOf,
  stateLabel,
} from "@/gates/gate-model";
import { gateStatus } from "@/components/status";
import { evidence } from "@/test/gate-fixtures";
import { gateView } from "@/test/ticket-fixtures";

test.each([
  ["passed", null, "success", "passed", null],
  ["running", null, "info", "running", null],
  ["waived", null, "neutral", "waived", null],
  [
    "failed",
    "blocking_findings",
    "danger",
    "failed (blocking findings)",
    "Open findings at a blocking severity.",
  ],
  [
    "failed",
    "reviewer_error",
    "warning",
    "failed (reviewer error)",
    "The reviewer failed: it exited non-zero or its findings did not parse. Not a finding.",
  ],
  [
    "failed",
    "superseded",
    "neutral",
    "failed (superseded)",
    "The ticket moved on while the review ran.",
  ],
  [
    "failed",
    "timeout",
    "neutral",
    "failed (timeout)",
    "No terminal event inside the gate's wall clock.",
  ],
  [
    "failed",
    "base_drift",
    "danger",
    "failed (base drift)",
    "The base moved under the review.",
  ],
  // A reason a newer server added reads as stored, with no note.
  ["failed", "brand_new_reason", "danger", "failed (brand new reason)", null],
  ["failed", null, "danger", "failed", null],
  ["pending", null, "neutral", "pending", null],
])(
  "%s (%s) reads in the %s tone (status.ts), label %j, note %j",
  (state, reason, tone, label, note) => {
    const gate = { state, reason };
    expect(gateStatus(gate).tone).toBe(tone);
    expect(stateLabel(gate)).toBe(label);
    expect(failureNote(gate)).toBe(note);
  },
);

test("a failure before a review shows its detail; full evidence, a bare reason and other states show none", () => {
  const why =
    "code_reviewer on local (unbound: every runner): fixture: code_review needs structured output";
  expect(
    failureDetail({
      state: "failed",
      evidence: { reason: "no_reviewer", detail: why },
    }),
  ).toBe(why);
  expect(
    failureDetail({ state: "failed", evidence: { reason: "timeout" } }),
  ).toBeNull();
  expect(
    failureDetail({
      state: "failed",
      evidence: evidence({ reason: "blocking_findings" }),
    }),
  ).toBeNull();
  expect(
    failureDetail({
      state: "waived",
      evidence: { reason: "no_reviewer", detail: why },
    }),
  ).toBeNull();
  expect(failureDetail({ state: "failed", evidence: null })).toBeNull();
  expect(
    failureDetail({ state: "failed", evidence: { reason: "x", detail: 3 } }),
  ).toBeNull();
});

test("the reviewer and its flags come from full evidence only", () => {
  expect(
    reviewerOf(
      evidence({
        runner_id: "reviewer-b",
        flags: {
          single_runner_review: true,
          fallback_from: "reviewer-a",
          base_drift: true,
        },
      }),
    ),
  ).toEqual({
    runner: "reviewer-b",
    flags: ["single-runner review", "fallback from reviewer-a", "base drift"],
  });
  expect(reviewerOf(evidence())).toEqual({ runner: "reviewer-b", flags: [] });
  expect(reviewerOf({ reason: "timeout" })).toBeNull();
  expect(reviewerOf(null)).toBeNull();
});

test("an attempt is an automatic retry when the one before it failed for a retry reason", () => {
  const timedOut = gateView({
    id: "g1",
    kind: "code_review",
    attempt: 1,
    state: "failed",
    reason: "timeout",
  });
  const retry = gateView({ id: "g2", kind: "code_review", attempt: 2 });
  expect(retriedAttempt(retry, [timedOut, retry])).toBe(timedOut);

  const refused = { ...timedOut, reason: "blocking_findings" };
  expect(retriedAttempt(retry, [refused, retry])).toBeNull();
  const otherRepo = { ...timedOut, repo_id: "repo-b" };
  expect(retriedAttempt(retry, [otherRepo, retry])).toBeNull();
  const stillRunning = { ...timedOut, state: "running" };
  expect(retriedAttempt(retry, [stillRunning, retry])).toBeNull();
  expect(retriedAttempt(timedOut, [timedOut, retry])).toBeNull();
});

test("the strip groups by kind and repo, in review order, latest attempt first", () => {
  const gates = [
    gateView({ id: "ce1", kind: "ce_review" }),
    gateView({ id: "cr1", kind: "code_review", attempt: 1 }),
    gateView({ id: "cr3", kind: "code_review", attempt: 3 }),
    gateView({ id: "cr2", kind: "code_review", attempt: 2 }),
    gateView({ id: "crb", kind: "code_review", repo_id: "repo-b" }),
    gateView({ id: "x1", kind: "parity_check" }),
    gateView({ id: "pr1", kind: "plan_review" }),
  ];
  expect(
    gateGroups(gates).map((g) => [g.latest.id, g.earlier.map((e) => e.id)]),
  ).toEqual([
    ["pr1", []],
    ["cr3", ["cr2", "cr1"]],
    ["crb", []],
    ["ce1", []],
    ["x1", []],
  ]);
  expect(gateGroups([])).toEqual([]);
});

test("a gate's name carries its repo when it has one", () => {
  expect(gateName({ kind: "code_review", repo_id: null })).toBe("code_review");
  expect(gateName({ kind: "code_review", repo_id: "example-org" })).toBe(
    "code_review · example-org",
  );
});
