import { describe, expect, test } from "vitest";
import {
  FLEET,
  FLEET_PAUSED,
  PROJECT,
  RESUME_FLEET,
  RESUME_PROJECT,
  STAFF_HINT,
  WORK_STATUSES,
  build,
  checkRows,
  holder,
  move,
  row,
  type Row,
} from "./fixtures.js";
import { MERGED, deliveryRow } from "../laws/fixtures.js";
import { nextStep, waitsOnYou } from "./next-step.js";
import { REASON_MAX } from "./next-step-text.js";

// nextStep, as a table: closed, what is already asked of the operator, the held
// statuses, the flag, backlog and the worker statuses with their holder. The statuses a gate decides
// are next-step-gates.test.ts's. Every row is also held to the board's flag (checkRows).

const OPEN_PR = {
  closeOnMerge: true,
  deliveries: [deliveryRow("R1", "pr_open")],
};

const ROWS: readonly Row[] = [
  // rework after a pull request: a merge closes it, an open one is the wait.
  row(
    "rework, nobody holds it, its pull request open",
    { status: "rework", law: { merge: OPEN_PR } },
    {
      waiting_on: "you",
      reason: "Waiting for the PR to be merged: https://forge.test/o/R1/pull/1",
    },
  ),
  row(
    "rework, a holder at work, its pull request open",
    {
      status: "rework",
      law: { merge: OPEN_PR },
      facts: { holder: holder("running", 3) },
    },
    { waiting_on: "agent", reason: "agent-7 is reworking it (turn 3)" },
  ),
  row(
    "rework, its pull requests merged",
    {
      status: "rework",
      law: { merge: MERGED },
      facts: { holder: holder("running", 3) },
    },
    {
      waiting_on: "nothing",
      reason: "Its pull requests merged: foreman moves it to done on its own",
    },
  ),
  // Closed, and what is already asked of the operator.
  row(
    "done",
    { status: "done" },
    { waiting_on: "nothing", reason: "Done: nothing left to do" },
  ),
  row(
    "rejected",
    { status: "rejected" },
    { waiting_on: "nothing", reason: "Rejected: nothing left to do" },
  ),
  row(
    "questions, before anything else",
    {
      status: "building",
      facts: { openQuestions: 2, holder: holder("running") },
    },
    {
      waiting_on: "you",
      reason: "Waiting on your answer to 2 questions",
      action: { kind: "answer", label: "Answer them", target: "questions" },
    },
  ),
  row(
    "one question",
    { status: "backlog", facts: { openQuestions: 1 } },
    {
      waiting_on: "you",
      reason: "Waiting on your answer to 1 question",
      action: { kind: "answer", label: "Answer it", target: "questions" },
    },
  ),
  row(
    "a staffing proposal",
    { status: "prioritized", facts: { proposalOpen: true } },
    {
      waiting_on: "you",
      reason: "Waiting on your approval of a staffing proposal",
      action: {
        kind: "answer",
        label: "Review the proposal",
        target: "proposal",
      },
    },
  ),
  // Held statuses.
  row(
    "blocked, with its condition",
    {
      status: "blocked",
      ticket: {
        blocked_reason: "circuit breaker: 3 failed runs",
        unblock_condition: "the runner is fixed",
      },
      law: { priorStatus: "building" },
    },
    {
      waiting_on: "you",
      reason:
        "Blocked: circuit breaker: 3 failed runs · unblocks when the runner is fixed",
      action: move("Unblock", "building"),
    },
  ),
  row(
    "blocked, nothing written and no way back",
    { status: "blocked" },
    { waiting_on: "you", reason: "Blocked: no reason given" },
  ),
  row(
    "parked, with its note",
    { status: "parked", facts: { parkNote: "waits on the design" } },
    {
      waiting_on: "nothing",
      reason: "Parked: waits on the design",
      action: move("Unpark", "backlog"),
    },
  ),
  row(
    "parked, flagged, with no note",
    { status: "parked", ticket: { needs_human: true } },
    {
      waiting_on: "nothing",
      reason: "Parked: no note given",
      action: move("Unpark", "backlog"),
    },
  ),
  row(
    "split, a child still open",
    { status: "split", law: { children: [{ id: "C1", status: "building" }] } },
    {
      waiting_on: "nothing",
      reason:
        "Split: waits for its child tickets (1 child ticket(s) still open: C1)",
    },
  ),
  row(
    "split, every child closed",
    { status: "split", law: { children: [{ id: "C1", status: "done" }] } },
    {
      waiting_on: "you",
      reason: "Its child tickets are closed: close the split",
      action: move("Close the split", "done"),
    },
  ),
  row(
    "released, no hand-off",
    { status: "handoff_pending", law: { priorStatus: "building" } },
    {
      waiting_on: "you",
      reason: "Released: reclaim it to go on",
      action: move("Reclaim", "building"),
    },
  ),
  row(
    "released with a hand-off, an orchestrator staffs it",
    { status: "handoff_pending", facts: { handoffPending: true } },
    {
      waiting_on: "orchestrator",
      reason:
        "Released with a hand-off: waiting for the orchestrator to staff a successor",
    },
  ),
  row(
    "released with a hand-off, no orchestrator",
    {
      status: "handoff_pending",
      law: { priorStatus: "building" },
      facts: { handoffPending: true, hasOrchestrator: false },
    },
    {
      waiting_on: "you",
      reason:
        "Released with a hand-off. No orchestrator in this project: staff a successor yourself",
      action: move("Reclaim", "building"),
    },
  ),
  row(
    "released with a hand-off, no orchestrator and no way back",
    {
      status: "handoff_pending",
      facts: { handoffPending: true, hasOrchestrator: false },
    },
    {
      waiting_on: "you",
      reason:
        "Released with a hand-off. No orchestrator in this project: staff a successor yourself",
      action: STAFF_HINT,
    },
  ),
  row(
    "the needs-human flag",
    {
      status: "building",
      ticket: { needs_human: true },
      facts: { holder: holder("running") },
    },
    {
      waiting_on: "you",
      reason: "Flagged needs human: look at it, then clear the flag",
      action: { kind: "none", label: "Clear the flag once handled" },
    },
  ),
  // backlog and prioritized.
  row(
    "backlog",
    { status: "backlog" },
    {
      waiting_on: "orchestrator",
      reason: "Waiting for the orchestrator to prioritise it",
    },
  ),
  row(
    "backlog, no orchestrator",
    { status: "backlog", facts: { hasOrchestrator: false } },
    {
      waiting_on: "you",
      reason: "No orchestrator in this project: prioritise it yourself",
      action: move("Prioritise", "prioritized"),
    },
  ),
  row(
    "backlog, the fleet paused",
    { status: "backlog", facts: { pause: FLEET } },
    {
      waiting_on: "paused",
      reason: `${FLEET_PAUSED}Waiting for the orchestrator to prioritise it`,
      action: RESUME_FLEET,
    },
  ),
  row(
    "backlog, the project paused",
    { status: "backlog", facts: { pause: PROJECT } },
    {
      waiting_on: "paused",
      reason:
        "Project is paused. Next: Waiting for the orchestrator to prioritise it",
      action: RESUME_PROJECT,
    },
  ),
  row(
    "prioritized",
    { status: "prioritized" },
    {
      waiting_on: "orchestrator",
      reason: "Prioritised: waiting for the orchestrator to staff it",
    },
  ),
  row(
    "prioritized, no orchestrator",
    { status: "prioritized", facts: { hasOrchestrator: false } },
    {
      waiting_on: "you",
      reason: "Prioritised. No orchestrator in this project: staff it yourself",
      action: STAFF_HINT,
    },
  ),
  // The worker statuses and their holder.
  row(
    "building, its holder running",
    { status: "building", facts: { holder: holder("running") } },
    { waiting_on: "agent", reason: "agent-7 is building (turn 14)" },
  ),
  row(
    "spiking, its holder idle",
    { status: "spiking", facts: { holder: holder("idle", 3) } },
    {
      waiting_on: "agent",
      reason: "agent-7 is writing the plan (turn 3, between turns)",
    },
  ),
  row(
    "staffed, its holder pending",
    { status: "staffed", facts: { holder: holder("pending", 0) } },
    { waiting_on: "agent", reason: "agent-7 is starting (pending)" },
  ),
  row(
    "planned, its holder preparing",
    { status: "planned", facts: { holder: holder("preparing", 0) } },
    { waiting_on: "agent", reason: "agent-7 is starting (preparing)" },
  ),
  row(
    "rework, its holder spawning",
    { status: "rework", facts: { holder: holder("spawning", 0) } },
    { waiting_on: "agent", reason: "agent-7 is starting (spawning)" },
  ),
  row(
    "review_fix, its holder waiting on an approval",
    { status: "review_fix", facts: { holder: holder("awaiting_approval") } },
    {
      waiting_on: "you",
      reason: "agent-7 waits for your approval of a tool call",
      action: { kind: "none", label: "Decide it in its session" },
    },
  ),
  row(
    "building, you attached",
    { status: "building", facts: { holder: holder("human_attached", 9) } },
    {
      waiting_on: "you",
      reason: "You are attached to agent-7's session (turn 9)",
    },
  ),
  row(
    "building, its holder writing a hand-off",
    { status: "building", facts: { holder: holder("handoff_writing") } },
    { waiting_on: "agent", reason: "agent-7 is writing its hand-off" },
  ),
  row(
    "building, its holder stopping",
    { status: "building", facts: { holder: holder("stopping") } },
    { waiting_on: "agent", reason: "agent-7 is stopping" },
  ),
  row(
    "review_fix, a hand-off pending",
    { status: "review_fix", facts: { handoffPending: true } },
    {
      waiting_on: "orchestrator",
      reason:
        "A hand-off is pending: waiting for the orchestrator to staff a successor",
    },
  ),
  row(
    "rework, nobody holds it and no orchestrator",
    { status: "rework", facts: { hasOrchestrator: false } },
    {
      waiting_on: "you",
      reason:
        "No session holds it. No orchestrator in this project: staff it yourself",
      action: STAFF_HINT,
    },
  ),
  row(
    "staffed, nobody holds it, the project paused",
    { status: "staffed", facts: { pause: PROJECT } },
    {
      waiting_on: "paused",
      reason:
        "Project is paused. Next: No session holds it: waiting for the orchestrator to staff it",
      action: RESUME_PROJECT,
    },
  ),
];

describe("nextStep", () => {
  checkRows(ROWS);

  test("every status but a gate's has a row (next-step-gates.test.ts has those)", () => {
    expect(new Set(ROWS.map((r) => r.facts.ticket.status))).toEqual(
      new Set(WORK_STATUSES),
    );
  });

  test("a reason is one line of at most 160 characters", () => {
    const long = nextStep(
      build({
        status: "blocked",
        ticket: { blocked_reason: "x ".repeat(200) },
      }),
    );
    expect(long.reason).toHaveLength(REASON_MAX);
    expect(long.reason.endsWith("…")).toBe(true);
  });

  test("the agent is the holder's, never a name of its own", () => {
    const got = nextStep(
      build({
        status: "building",
        facts: { holder: { agent: "who-ever", state: "running", turns: 2 } },
      }),
    );
    expect(got.reason).toBe("who-ever is building (turn 2)");
  });

  test("waitsOnYou is `you` or a pause only you can lift", () => {
    expect(waitsOnYou({ waiting_on: "you" })).toBe(true);
    expect(waitsOnYou({ waiting_on: "paused" })).toBe(true);
    for (const w of [
      "agent",
      "reviewer",
      "qa",
      "orchestrator",
      "nothing",
    ] as const)
      expect(waitsOnYou({ waiting_on: w })).toBe(false);
  });
});
