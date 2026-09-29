import { describe, expect, test } from "vitest";
import { planRetry, retriesUsed, type RetryGateFact } from "./retry.js";
import {
  GATE_REVIEW_STATUS,
  isReviewGateKind,
  isRoundGateKind,
} from "./roles.js";

// decideGate's retry: a timeout or a restart opens the next attempt of the same kind and repo,
// while the ticket still waits on that review, nothing else of the kind runs, and the budget lasts.

const g = (
  id: string,
  attempt: number,
  o: Partial<RetryGateFact> = {},
): RetryGateFact => ({
  id,
  kind: "code_review",
  repo_id: null,
  attempt,
  round: 1,
  state: "failed",
  reason: null,
  ...o,
});

const TICKET = {
  status: "code_review",
  non_trivial: false,
  plan_path: "docs/p.md",
};

const input = (
  decided: RetryGateFact,
  gates: readonly RetryGateFact[],
  o: { status?: string; retries?: number } = {},
) => ({
  decided,
  gates,
  ticket: { ...TICKET, status: o.status ?? TICKET.status },
  retries: o.retries ?? 1,
});

describe("planRetry", () => {
  test("a CI gate is never retried: its timeout is CI's own clock, not an interrupted reviewer", () => {
    const decided = g("g1", 1, {
      kind: "qa_harness",
      reason: "timeout",
      subject_kind: "pull_request",
    });
    expect(
      planRetry(input(decided, [decided], { status: "qa_harness" })),
    ).toBeNull();
    // The same gate running a command is retried, so the refusal is the subject's alone.
    const command = { ...decided, subject_kind: "workspace" };
    expect(
      planRetry(input(command, [command], { status: "qa_harness" })),
    ).toMatchObject({
      kind: "qa_harness",
      attempt: 2,
      subject_kind: "workspace",
    });
  });

  test("a first timeout opens attempt n+1 of the same kind and repo", () => {
    const decided = g("g1", 1, { reason: "timeout", repo_id: "r1" });
    expect(planRetry(input(decided, [decided]))).toEqual({
      kind: "code_review",
      repo_id: "r1",
      attempt: 2,
      round: 1,
      subject_kind: "diff",
      subject_ref: "unpinned",
    });
  });

  test("a supervisor restart is retried too, and a plan_review keeps its plan subject", () => {
    const decided = g("g1", 3, {
      kind: "plan_review",
      reason: "supervisor_restart",
    });
    expect(
      planRetry(input(decided, [decided], { status: "plan_review" })),
    ).toMatchObject({
      attempt: 4,
      subject_kind: "plan",
      subject_ref: "docs/p.md",
    });
  });

  test("the attempt is one past the highest of the kind across repos", () => {
    const decided = g("g1", 2, { reason: "timeout", repo_id: "r1" });
    const other = g("g2", 5, { repo_id: "r2" });
    expect(planRetry(input(decided, [decided, other]))?.attempt).toBe(6);
  });

  test("a second consecutive timeout is not retried with the default budget", () => {
    const first = g("g1", 1, { reason: "timeout" });
    const second = g("g2", 2, { reason: "timeout" });
    expect(planRetry(input(second, [first, second]))).toBeNull();
    expect(
      planRetry(input(second, [first, second], { retries: 2 })),
    ).not.toBeNull();
  });

  test("a streak ends at an attempt that failed for another reason", () => {
    const reviewed = g("g1", 1, { reason: "blocking_findings" });
    const passed = g("g2", 2, { state: "passed" });
    const timedOut = g("g3", 3, { reason: "timeout" });
    expect(retriesUsed(input(timedOut, [reviewed, passed, timedOut]))).toBe(0);
    expect(retriesUsed(input(timedOut, [reviewed, timedOut]))).toBe(0);
    const restarted = g("g0", 2, { reason: "supervisor_restart" });
    expect(retriesUsed(input(timedOut, [reviewed, restarted, timedOut]))).toBe(
      1,
    );
  });

  test("other repos and kinds do not spend this review's budget", () => {
    const elsewhere = g("g1", 1, { reason: "timeout", repo_id: "r2" });
    const ce = g("g2", 1, { reason: "timeout", kind: "ce_review" });
    const decided = g("g3", 2, { reason: "timeout", repo_id: "r1" });
    expect(retriesUsed(input(decided, [elsewhere, ce, decided]))).toBe(0);
  });

  test.each<[string, RetryGateFact, { status?: string; retries?: number }]>([
    ["no reason", g("g1", 1), {}],
    ["a reviewed failure", g("g1", 1, { reason: "blocking_findings" }), {}],
    ["a superseded gate", g("g1", 1, { reason: "superseded" }), {}],
    [
      "the ticket left code_review",
      g("g1", 1, { reason: "timeout" }),
      { status: "review_fix" },
    ],
    [
      "no retries configured",
      g("g1", 1, { reason: "timeout" }),
      { retries: 0 },
    ],
    [
      // `human_qa` is the one kind no edge opens a round of: an earlier change gave `qa_harness` one, so it
      // is retried like any other job gate.
      "a kind no round opens",
      g("g1", 1, { reason: "timeout", kind: "human_qa" }),
      {},
    ],
  ])("none: %s", (_name, decided, o) => {
    expect(planRetry(input(decided, [decided], o))).toBeNull();
  });

  test("none while another gate of the kind is running", () => {
    const decided = g("g1", 1, { reason: "timeout", repo_id: "r1" });
    const sibling = g("g2", 1, { state: "running", repo_id: "r2" });
    expect(planRetry(input(decided, [decided, sibling]))).toBeNull();
  });

  // a supervisor restart mid-gate decides every running gate `supervisor_restart`. A
  // parity_check left permanently failed by that has no way back but an operator waive or a fresh
  // round that discards the round's passed code_review evidence with it.
  test("a parity_check that met a restart is retried, repo-less and workspace-subjected", () => {
    const decided = g("g1", 1, {
      kind: "parity_check",
      reason: "supervisor_restart",
    });
    expect(planRetry(input(decided, [decided]))).toEqual({
      kind: "parity_check",
      repo_id: null,
      attempt: 2,
      round: 1,
      subject_kind: "workspace",
      subject_ref: "unpinned",
    });
  });

  //, 023: the reviewer never had its say, so a retry is the same review asked again and
  // stays in its round. One that opened a new round would strand every other kind of that round a
  // round behind, and pass_review would then refuse a ticket whose gates had all been decided.
  test("a retry keeps the round of the gate it follows", () => {
    const decided = g("g3", 2, { reason: "timeout", round: 4 });
    const earlier = g("g1", 1, { round: 3 });
    expect(planRetry(input(decided, [earlier, decided]))).toMatchObject({
      attempt: 3,
      round: 4,
    });
  });

  test("a parity_check is retried in code_review, the status its round opens in", () => {
    const decided = g("g1", 1, { kind: "parity_check", reason: "timeout" });
    expect(
      planRetry(input(decided, [decided], { status: "qa_harness" })),
    ).toBeNull();
    expect(planRetry(input(decided, [decided]))).not.toBeNull();
  });

  // and a qa_harness is retried in `qa_harness`, where `pass_review` opened it — its
  // subject is the workspace, as parity's is, not one repo's range.
  test("a qa_harness is retried in qa_harness, repo-less, over the workspace", () => {
    const decided = g("g1", 1, {
      kind: "qa_harness",
      reason: "timeout",
      repo_id: null,
    });
    expect(planRetry(input(decided, [decided]))).toBeNull();
    expect(
      planRetry(input(decided, [decided], { status: "qa_harness" })),
    ).toMatchObject({
      kind: "qa_harness",
      repo_id: null,
      attempt: 2,
      subject_kind: "workspace",
    });
  });
});

test("the review statuses and kinds", () => {
  expect(GATE_REVIEW_STATUS.ce_review).toBe("code_review");
  expect(isReviewGateKind("plan_review")).toBe(true);
  expect(isReviewGateKind("human_qa")).toBe(false);
  // parity_check is a round kind but not a reviewed one: a script decides it, and the round that
  // opens it may reopen it.
  expect(isReviewGateKind("parity_check")).toBe(false);
  expect(isRoundGateKind("parity_check")).toBe(true);
  // pass_review opens it, so it is retried after a restart and rerunnable.
  expect(isRoundGateKind("qa_harness")).toBe(true);
  expect(GATE_REVIEW_STATUS.qa_harness).toBe("qa_harness");
  expect(isRoundGateKind("human_qa")).toBe(false);
  expect(GATE_REVIEW_STATUS.parity_check).toBe("code_review");
});
