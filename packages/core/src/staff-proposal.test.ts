import { expect, test } from "vitest";
import {
  StaffDecision,
  StaffProposal,
  staffDecisionOf,
  staffProposalContext,
  staffProposalKey,
  staffProposalQuestion,
} from "./staff-proposal.js";
import { StaffRefusalReason } from "./staffing.js";

// A staffing proposal's pure parts: its key is one per ticket, role and phase; its
// question names who and what; an answer is approve or reject, however it is cased or spaced.

const proposal: StaffProposal = {
  agent_id: "shop-builder",
  runner_id: "runner-a",
  role: "builder",
  run_class: "build",
  handoff_id: null,
};

test("the key holds the ticket, the role and the phase: its run class and its hand-off", () => {
  expect(staffProposalKey("T1", proposal)).toBe("staff:T1:builder:build:-");
  expect(staffProposalKey("T1", { ...proposal, handoff_id: "H9" })).toBe(
    "staff:T1:builder:build:H9",
  );
  expect(staffProposalKey("T1", { ...proposal, run_class: "fix" })).not.toBe(
    staffProposalKey("T1", proposal),
  );
  // Not the agent: a phase is proposed once, whoever it would staff.
  const other: StaffProposal = { ...proposal, agent_id: "other" };
  expect(staffProposalKey("T1", other)).toBe(staffProposalKey("T1", proposal));
});

test("the question and context name the agent, role, run class, runner and hand-off", () => {
  expect(staffProposalQuestion("SHOP-7", proposal)).toBe(
    "Staff SHOP-7 with shop-builder (builder, build)?",
  );
  expect(staffProposalContext(proposal)).toContain(
    "Runner: runner-a. Hand-off: none.",
  );
  expect(staffProposalContext({ ...proposal, handoff_id: "H9" })).toContain(
    "Hand-off: H9.",
  );
});

test("an answer is a decision whatever its case and spacing, and nothing else is", () => {
  expect(StaffDecision.options).toEqual(["approve", "reject"]);
  expect(staffDecisionOf("approve")).toBe("approve");
  expect(staffDecisionOf("  Reject \n")).toBe("reject");
  for (const text of ["yes", "approved", "", "approve it"]) {
    expect(staffDecisionOf(text), text).toBeNull();
  }
});

test("a stored proposal is strict, and approval_pending is a closed staffing reason", () => {
  expect(StaffProposal.safeParse({ ...proposal, extra: 1 }).success).toBe(
    false,
  );
  expect(
    StaffProposal.safeParse({ ...proposal, role: "orchestrator" }).success,
  ).toBe(false);
  expect(StaffRefusalReason.options).toContain("approval_pending");
});
