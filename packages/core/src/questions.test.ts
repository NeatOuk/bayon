import { expect, test } from "vitest";
import { needsHumanHeld } from "./laws/patch.js";
import {
  NOT_A_QUESTION_KIND,
  closedQuestionKey,
  normalizeQuestion,
  openQuestionKey,
} from "./questions.js";

// A ticket's questions to the operator: which requests are questions, how a repeat is
// recognised, the key's two states, and the PATCH law that keeps needs_human while one is open.

test("every kind but a staffing proposal is a question", () => {
  expect(NOT_A_QUESTION_KIND).toBe("staff_approval");
});

test("normalizeQuestion: NFC, case, whitespace and trailing punctuation do not make a new question", () => {
  expect(normalizeQuestion("  Keep  the v1\nroutes?  ")).toBe(
    normalizeQuestion("keep the V1 routes"),
  );
  expect(normalizeQuestion("Ship it?!.")).toBe("ship it");
  expect(normalizeQuestion("Café?")).toBe(normalizeQuestion("Café"));
  // Punctuation inside the question is part of it.
  expect(normalizeQuestion("v1 or v2?")).not.toBe(normalizeQuestion("v1, v2"));
});

test("the key names its status: open, then answered by the request's id", () => {
  const open = openQuestionKey("T1", "0123456789abcdef");
  expect(open).toBe("ask:T1:0123456789abcdef:open");
  expect(closedQuestionKey(open, "R1", "answered")).toBe(
    "ask:T1:0123456789abcdef:answered:R1",
  );
  expect(closedQuestionKey(open, "R1", "dismissed")).toBe(
    "ask:T1:0123456789abcdef:dismissed:R1",
  );
  // Only an open ask key is rewritten: a system request's key, or none, stays as it is.
  expect(closedQuestionKey("split:T1:4", "R1", "answered")).toBeNull();
  expect(closedQuestionKey(null, "R1", "dismissed")).toBeNull();
  expect(
    closedQuestionKey("ask:T1:x:answered:R0", "R1", "answered"),
  ).toBeNull();
});

test("needsHumanHeld: no clear while a question is open, whoever asks; none open, no hold", () => {
  expect(needsHumanHeld(0)).toBeNull();
  expect(needsHumanHeld(1)).toMatchObject({
    allowed: false,
    rule: "patch",
    reason: "questions_open",
    detail: expect.stringContaining(
      "1 open question to the operator: answer it in the Inbox",
    ),
  });
  expect(needsHumanHeld(3)?.detail).toContain(
    "3 open questions to the operator: answer them in the Inbox",
  );
});
