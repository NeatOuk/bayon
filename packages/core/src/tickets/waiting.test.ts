import { expect, test } from "vitest";
import {
  FLEET,
  GATE_STATUSES,
  NO_REVIEWER,
  WORK_STATUSES,
  build,
  waitFactsOf,
  type Build,
} from "./fixtures.js";
import { TICKET_STATUSES } from "../laws/statuses.js";
import { WAIT_REASON_MAX, waitingOnYou } from "./waiting.js";

// waitingOnYou, the board's flag. Its agreement with nextStep is checked on every row of
// nextStep's two tables (checkRows); here, what it says, and that the tables cover every status.

const say = (b: Build) => {
  const facts = waitFactsOf(build(b));
  return facts === null ? null : waitingOnYou(facts);
};

test("its short reasons say what the page says", () => {
  expect(say({ status: "backlog", facts: { openQuestions: 1 } })).toEqual({
    code: "questions",
    reason: "Waiting on your answer to 1 question",
  });
  expect(say({ status: "code_review", gates: [NO_REVIEWER] })).toEqual({
    code: "gate",
    reason: "Review can't run: no eligible reviewer",
  });
  expect(say({ status: "qa_harness" })).toEqual({
    code: "qa_note",
    reason: "QA needs your note (no QA harness configured)",
  });
  expect(say({ status: "backlog", facts: { pause: FLEET } })).toEqual({
    code: "paused",
    reason: "Fleet is paused: nothing new starts until you resume it",
  });
  expect(say({ status: "rework", facts: { hasOrchestrator: false } })).toEqual({
    code: "no_orchestrator",
    reason: "No orchestrator in this project: staff it yourself",
  });
  expect(say({ status: "parked", facts: { parkNote: "later" } })).toBeNull();
  expect(say({ status: "building" })).toBeNull();
});

test("a card's reason is cut to fit its chip", () => {
  const got = say({
    status: "blocked",
    ticket: { blocked_reason: "y".repeat(300) },
  });
  expect(got?.reason).toHaveLength(WAIT_REASON_MAX);
  expect(got?.reason.endsWith("…")).toBe(true);
});

test("nextStep's two tables split the statuses between them", () => {
  expect([...WORK_STATUSES, ...GATE_STATUSES].sort()).toEqual(
    [...TICKET_STATUSES].sort(),
  );
});
