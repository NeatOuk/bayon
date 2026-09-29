// Staffing's refusals over REST: one table places every reason, so none falls through to another
// status. cross_project is a 409 conflict that asking again will not change;
// approval_pending one the operator's answer will — the operator's own door never meets it.
import { StaffRefusalReason } from "@bayon/core";
import { expect, test } from "vitest";
import { httpStatus } from "../errors.js";
import { staffRefusalError } from "./staffing.js";

test("every staffing refusal has its REST class, status and retryability", () => {
  const shaped = Object.fromEntries(
    StaffRefusalReason.options.map((reason) => {
      const e = staffRefusalError({ reason, detail: "d" });
      expect(e.message).toBe(`${reason}: d`);
      return [reason, [e.class, httpStatus(e.class), e.retryable]];
    }),
  );
  expect(shaped).toEqual({
    not_staffable: ["conflict", 409, false],
    awaiting_human: ["conflict", 409, true],
    over_budget: ["admission_refused", 429, true],
    no_agent: ["admission_refused", 429, true],
    holder_releasing: ["conflict", 409, true],
    cross_project: ["conflict", 409, false],
    approval_pending: ["conflict", 409, true],
  });
});
