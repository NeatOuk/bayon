import { describe, expect, test } from "vitest";
import { CI_SUBJECT } from "../gates/ci.js";
import { EVIDENCE, MERGED, deliveryRow, gate } from "../laws/fixtures.js";
import type { MergeFacts } from "../laws/types.js";
import {
  BROKE,
  FLEET,
  FLEET_PAUSED,
  GATE_STATUSES,
  NO_REVIEWER,
  RESUME_FLEET,
  SUPERSEDED,
  TIMED_OUT,
  UNREADABLE,
  checkRows,
  failed,
  move,
  onCode,
  row,
  running,
  waitFactsOf,
  type Row,
} from "./fixtures.js";
import { cap } from "./next-step-text.js";

// nextStep for the statuses a gate decides: machine steps, running reviewers, each
// failure class, the stalls nothing will reopen, and QA. Every row is held to the board's flag too
// (checkRows); the worker and held statuses are next-step.test.ts's.

/** Every pull request still open, in a project that closes on merge. */
const OPEN_PR: MergeFacts = {
  closeOnMerge: true,
  deliveries: [deliveryRow("R1", "pr_open")],
};
const PR_URL = "https://forge.test/o/R1/pull/1";

const GATE_ROWS: readonly Row[] = [
  // plan_review.
  row(
    "plan_review, the reviewer at work",
    {
      status: "plan_review",
      gates: [running("plan_review", { id: "pr", attempt: 2 })],
      facts: { liveGateIds: ["pr"] },
    },
    {
      waiting_on: "reviewer",
      reason: "Reviewer is reviewing the plan (attempt 2)",
    },
  ),
  row(
    "plan_review, no reviewer started yet",
    { status: "plan_review", gates: [running("plan_review")] },
    {
      waiting_on: "reviewer",
      reason: "Waiting for a reviewer to start plan_review (attempt 1)",
    },
  ),
  row(
    "plan_review, no reviewer started yet, the fleet paused",
    {
      status: "plan_review",
      gates: [running("plan_review")],
      facts: { pause: FLEET },
    },
    {
      waiting_on: "paused",
      reason: `${FLEET_PAUSED}Waiting for a reviewer to start plan_review (attempt 1)`,
      action: RESUME_FLEET,
    },
  ),
  row(
    "plan_review passed: a machine step",
    {
      status: "plan_review",
      ticket: { non_trivial: true },
      gates: [gate({ kind: "plan_review" })],
    },
    {
      waiting_on: "nothing",
      reason: "Plan review passed: foreman moves it to planned on its own",
      action: move("Move it now", "planned"),
    },
  ),
  row(
    "plan_review, no reviewer",
    {
      status: "plan_review",
      gates: [
        failed("plan_review", "no_reviewer", {
          evidence: { reason: "no_reviewer", detail: "no certified runner" },
        }),
      ],
    },
    {
      waiting_on: "you",
      reason:
        "Plan review can't run: no eligible reviewer (no certified runner)",
      action: {
        kind: "configure",
        label: "Set up a reviewer",
        target: "runners",
      },
    },
  ),
  row(
    "plan_review, the plan changed source files",
    { status: "plan_review", gates: [failed("plan_review", "source_changes")] },
    {
      waiting_on: "orchestrator",
      reason:
        "Plan review failed: the plan changed source files: waiting for the orchestrator to send it back (revise_plan)",
      action: move("Revise the plan", "spiking"),
    },
  ),
  // A plan is not diffed against its base, so drift is not judged there (H4): a drift recorded on
  // a plan review from before that rule is under no cap, and is the operator's to send back.
  row(
    "plan_review drifted: uncapped, the operator sends it back",
    { status: "plan_review", gates: [failed("plan_review", "base_drift")] },
    {
      waiting_on: "you",
      reason:
        "Plan review stopped: the base branch moved, so send it back to fix",
      action: move("Revise the plan", "spiking"),
    },
  ),
  row(
    "plan_review failed on findings, no orchestrator",
    {
      status: "plan_review",
      gates: [onCode("plan_review")],
      facts: { hasOrchestrator: false },
    },
    {
      waiting_on: "you",
      reason:
        "Plan review failed on blocking findings: send it back yourself (revise_plan)",
      action: move("Revise the plan", "spiking"),
    },
  ),
  row(
    "plan_review failed on findings, the fleet paused",
    {
      status: "plan_review",
      gates: [onCode("plan_review")],
      facts: { pause: FLEET },
    },
    {
      waiting_on: "paused",
      reason: `${FLEET_PAUSED}Plan review failed on blocking findings: waiting for the orchestrator to send it back (revise_plan)`,
      action: RESUME_FLEET,
    },
  ),
  row(
    "plan_review with no gate at all",
    { status: "plan_review" },
    {
      waiting_on: "you",
      reason:
        "Plan review is not moving: the round's plan_review has not passed",
      action: move("Revise the plan", "spiking"),
    },
  ),
  // code_review.
  row(
    "code_review, the reviewers at work",
    {
      status: "code_review",
      gates: [
        running("ce_review", { id: "ce" }),
        running("code_review", { id: "cr", attempt: 3 }),
        running("lint_check"),
      ],
      facts: { liveGateIds: ["cr"] },
    },
    { waiting_on: "reviewer", reason: "Reviewer is reviewing (attempt 3)" },
  ),
  row(
    "code_review, only the lint job running",
    {
      status: "code_review",
      gates: [gate({ kind: "code_review" }), running("lint_check")],
    },
    { waiting_on: "reviewer", reason: "lint_check is running (attempt 1)" },
  ),
  row(
    "code_review passed: a machine step",
    { status: "code_review", gates: [gate({ kind: "code_review" })] },
    {
      waiting_on: "nothing",
      reason: "Review passed: foreman moves it to qa_harness on its own",
      action: move("Move it now", "qa_harness"),
    },
  ),
  row(
    "code_review failed on findings: a machine step",
    { status: "code_review", gates: [onCode("code_review")] },
    {
      waiting_on: "nothing",
      reason:
        "Review failed on blocking findings: foreman moves it to review_fix on its own",
      action: move("Move it now", "review_fix"),
    },
  ),
  row(
    "code_review, no reviewer",
    { status: "code_review", gates: [NO_REVIEWER] },
    {
      waiting_on: "you",
      reason:
        "Review can't run: no eligible reviewer (no certified runner is enabled)",
      action: {
        kind: "configure",
        label: "Set up a reviewer",
        target: "runners",
      },
    },
  ),
  row(
    "code_review timed out",
    { status: "code_review", gates: [TIMED_OUT] },
    {
      waiting_on: "you",
      reason: "Review timed out",
      action: {
        kind: "rerun_gate",
        label: "Rerun code_review",
        target: "cr-to",
      },
    },
  ),
  row(
    "code_review, the reviewer broke after writing evidence",
    { status: "code_review", gates: [BROKE] },
    {
      waiting_on: "you",
      reason: "Review failed: the reviewer broke",
      action: {
        kind: "rerun_gate",
        label: "Rerun code_review",
        target: "cr-err",
      },
    },
  ),
  row(
    "code_review, the base moved: a machine step",
    { status: "code_review", gates: [failed("code_review", "base_drift")] },
    {
      waiting_on: "nothing",
      reason:
        "Review stopped: the base branch moved: foreman moves it to review_fix on its own",
      action: move("Move it now", "review_fix"),
    },
  ),
  row(
    "code_review, the base moved in 3 rounds running: the cap leaves it to you",
    {
      status: "code_review",
      gates: [
        failed("code_review", "base_drift"),
        failed("code_review", "base_drift", {
          id: "cr-2",
          attempt: 2,
          round: 2,
        }),
        failed("code_review", "base_drift", {
          id: "cr-3",
          attempt: 3,
          round: 3,
        }),
      ],
    },
    {
      waiting_on: "you",
      reason:
        "Review stopped: the base moved in 3 rounds running, so you decide",
      action: move("Send back to fix", "review_fix"),
    },
  ),
  row(
    "code_review, the base moved under a review that found only minor issues",
    {
      status: "code_review",
      gates: [
        gate({
          kind: "code_review",
          state: "failed",
          evidence: {
            ...EVIDENCE,
            flags: { base_drift: true },
            reason: "base_drift",
          },
          openSeverities: ["minor"],
        }),
      ],
    },
    {
      waiting_on: "nothing",
      reason:
        "Review stopped: the base branch moved: foreman moves it to review_fix on its own",
      action: move("Move it now", "review_fix"),
    },
  ),
  row(
    "code_review superseded: a reclaimed ticket nothing reopens",
    { status: "code_review", gates: [SUPERSEDED] },
    {
      waiting_on: "you",
      reason: "Review is not moving: code_review is failed",
      action: {
        kind: "rerun_gate",
        label: "Rerun code_review",
        target: "cr-sup",
      },
    },
  ),
  row(
    "code_review, both machine steps apply",
    {
      status: "code_review",
      gates: [
        gate({ kind: "code_review" }),
        onCode("ce_review", { id: "ce-code" }),
      ],
    },
    {
      waiting_on: "you",
      reason:
        "Review is not moving: pass_review and request_fix both apply; the operator decides",
      action: {
        kind: "rerun_gate",
        label: "Rerun ce_review",
        target: "ce-code",
      },
    },
  ),
  row(
    "code_review failed on findings since resolved",
    {
      status: "code_review",
      gates: [onCode("code_review", { id: "cr-res", openSeverities: [] })],
    },
    {
      waiting_on: "you",
      reason: "Review is not moving: code_review is failed",
      action: {
        kind: "rerun_gate",
        label: "Rerun code_review",
        target: "cr-res",
      },
    },
  ),
  row(
    "code_review, ce_review became required mid-round",
    {
      status: "code_review",
      ticket: { non_trivial: true },
      gates: [gate({ kind: "code_review" })],
    },
    {
      waiting_on: "you",
      reason: cap(
        "Review is not moving: no ce_review gate in this ticket's current review round (1): ce_review became required after the round opened, so the round opened none and there is no gate to waive. Take request_fix, then resubmit: the new round opens it.",
      ),
      action: move("Send back to fix", "review_fix"),
    },
  ),
  row(
    "code_review, a failure whose evidence does not read",
    { status: "code_review", gates: [UNREADABLE] },
    {
      waiting_on: "you",
      reason: "Review is not moving: code_review is failed",
      action: {
        kind: "rerun_gate",
        label: "Rerun code_review",
        target: "cr-bad",
      },
    },
  ),
  row(
    "code_review, the gate settings unreadable",
    {
      status: "code_review",
      gateFacts: {
        state: "unavailable",
        detail: "gates.blocking_severities is not a list",
      },
    },
    {
      waiting_on: "you",
      reason:
        "Gate facts are unavailable: gates.blocking_severities is not a list",
      action: {
        kind: "configure",
        label: "Check the gate settings",
        target: "settings",
      },
    },
  ),
  // QA.
  row(
    "qa_harness, no QA configured",
    { status: "qa_harness" },
    {
      waiting_on: "you",
      reason: "QA needs your note (no QA harness configured)",
      action: move("Pass with a note", "qa_human"),
    },
  ),
  row(
    "qa_harness, the harness running",
    {
      status: "qa_harness",
      gates: [running("qa_harness")],
      facts: { qaConfigured: true },
    },
    { waiting_on: "qa", reason: "The QA harness is running (attempt 1)" },
  ),
  // a CI gate runs nothing; it waits for the pull request, then for its checks.
  row(
    "qa_harness, a CI gate with no pull request at the head yet",
    {
      status: "qa_harness",
      gates: [running("qa_harness", { subjectKind: CI_SUBJECT })],
      facts: { qaConfigured: true },
    },
    { waiting_on: "qa", reason: "Waiting for the PR to be opened" },
  ),
  row(
    "qa_harness, a CI gate reading its checks",
    {
      status: "qa_harness",
      gates: [running("qa_harness", { subjectKind: CI_SUBJECT })],
      facts: { qaConfigured: true, ci: { pulls: 1, done: 2, total: 5 } },
    },
    { waiting_on: "qa", reason: "CI running on the PR (2 of 5 checks done)" },
  ),
  row(
    "qa_harness, a CI gate whose pull request has no check yet",
    {
      status: "qa_harness",
      gates: [running("qa_harness", { subjectKind: CI_SUBJECT })],
      facts: { qaConfigured: true, ci: { pulls: 2, done: 0, total: 0 } },
    },
    {
      waiting_on: "qa",
      reason: "CI running on the PR (no checks reported yet)",
    },
  ),
  row(
    "qa_harness passed: a machine step",
    {
      status: "qa_harness",
      gates: [gate({ kind: "qa_harness" })],
      facts: { qaConfigured: true },
    },
    {
      waiting_on: "nothing",
      reason: "QA passed: foreman moves it to qa_human on its own",
      action: move("Move it now", "qa_human"),
    },
  ),
  row(
    "qa_human",
    { status: "qa_human" },
    {
      waiting_on: "you",
      reason: "Waiting on your human QA: pass it, or fail it with a reason",
      action: move("Pass human QA", "done"),
    },
  ),
  row(
    "qa_human, a child still open",
    {
      status: "qa_human",
      law: { children: [{ id: "C2", status: "building" }] },
    },
    {
      waiting_on: "you",
      reason:
        "Waiting on your human QA: pass it, or fail it with a reason; it cannot pass yet: 1 child ticket(s) still open: C2",
      action: move("Fail human QA", "rework"),
    },
  ),
  row(
    "qa_human, no option offered",
    { status: "qa_human", facts: { transitions: [] } },
    {
      waiting_on: "you",
      reason:
        "Waiting on your human QA: pass it, or fail it with a reason; it cannot pass yet: the laws refuse it",
    },
  ),
];

// A merged pull request closes a ticket after review; an open one is what it waits for.
const MERGE_ROWS: readonly Row[] = [
  row(
    "qa_human, its pull request open",
    { status: "qa_human", law: { merge: OPEN_PR } },
    {
      waiting_on: "you",
      reason: `Waiting for the PR to be merged: ${PR_URL}`,
      action: move("Pass human QA", "done"),
    },
  ),
  row(
    "qa_human, two pull requests open",
    {
      status: "qa_human",
      law: {
        merge: {
          closeOnMerge: true,
          deliveries: [
            deliveryRow("R1", "pr_open"),
            deliveryRow("R2", "pr_open"),
          ],
        },
      },
    },
    {
      waiting_on: "you",
      reason: `Waiting for 2 PRs to be merged: ${PR_URL} https://forge.test/o/R2/pull/1`,
      action: move("Pass human QA", "done"),
    },
  ),
  row(
    "qa_human, its pull requests merged",
    { status: "qa_human", law: { merge: MERGED } },
    {
      waiting_on: "nothing",
      reason: "Its pull requests merged: foreman moves it to done on its own",
    },
  ),
  row(
    "qa_human, open but the project does not close on merge",
    { status: "qa_human", law: { merge: { ...OPEN_PR, closeOnMerge: false } } },
    {
      waiting_on: "you",
      reason: "Waiting on your human QA: pass it, or fail it with a reason",
      action: move("Pass human QA", "done"),
    },
  ),
  row(
    "qa_harness, no harness, its pull request open",
    { status: "qa_harness", law: { merge: OPEN_PR } },
    {
      waiting_on: "you",
      reason: `Waiting for the PR to be merged: ${PR_URL}`,
      action: move("Pass QA", "qa_human"),
    },
  ),
  row(
    "qa_harness, the harness running and the pull request open: the harness is the wait",
    {
      status: "qa_harness",
      law: { merge: OPEN_PR },
      gates: [running("qa_harness", { id: "qa" })],
      facts: { qaConfigured: true },
    },
    { waiting_on: "qa", reason: "The QA harness is running (attempt 1)" },
  ),
  row(
    "qa_harness, the harness running and the pull request merged",
    {
      status: "qa_harness",
      law: { merge: MERGED },
      gates: [running("qa_harness", { id: "qa" })],
      facts: { qaConfigured: true },
    },
    {
      waiting_on: "nothing",
      reason: "Its pull requests merged: foreman moves it to done on its own",
    },
  ),
];

describe("nextStep, gate statuses", () => {
  checkRows(GATE_ROWS);
  checkRows(MERGE_ROWS);

  test("every gate status has a row", () => {
    expect(new Set(GATE_ROWS.map((r) => r.facts.ticket.status))).toEqual(
      new Set(GATE_STATUSES),
    );
  });

  test("only the unreadable gate settings are the page's alone, not the board's", () => {
    expect(
      GATE_ROWS.filter((r) => waitFactsOf(r.facts) === null).map((r) => r.name),
    ).toEqual(["code_review, the gate settings unreadable"]);
  });
});
