import { describe, expect, test } from "vitest";
import { lawTicket } from "./fixtures.js";
import { planTransition, requiredFacts } from "./plan.js";
import type { TicketStatus } from "./statuses.js";
import type { TransitionInput } from "./types.js";

// What the service builds before the transaction: the facts to gather, then the writer's patch
// (the edge's effects) and payload (evidence refs).

const NOW = 1_700_000_000_000;

const plan = (
  status: TicketStatus,
  to: TicketStatus,
  input: TransitionInput = {},
  priorStatus: TicketStatus | null = null,
) =>
  planTransition({
    ticket: lawTicket(status),
    priorStatus,
    to,
    input,
    now: NOW,
  });

describe("requiredFacts", () => {
  test("only submit_plan runs git and checks the plan file", () => {
    expect(
      [...requiredFacts("spiking", "plan_review", null)].toSorted(),
    ).toEqual(["diff", "plan"]);
    expect(requiredFacts("staffed", "spiking", null).size).toBe(0);
    expect(requiredFacts("done", "backlog", null).size).toBe(0);
  });
});

describe("planTransition", () => {
  test("a plain edge has an empty patch and a payload naming its rule", () => {
    expect(plan("planned", "building")).toEqual({
      rule: "start_build",
      to: "building",
      patch: {},
      payload: { rule: "start_build" },
      gates: { opens: [], supersede: [] },
    });
  });

  test("the edge's gate effects ride along (M3)", () => {
    expect(plan("building", "code_review")).toMatchObject({
      gates: {
        opens: [
          { gate: "code_review", when: "always" },
          { gate: "ce_review", when: "non_trivial" },
          { gate: "parity_check", when: "multi_repo" },
          { gate: "lint_check", when: "lint_configured" },
        ],
      },
    });
  });

  test("ask_human raises needs_human", () => {
    expect(plan("building", "prioritized")).toMatchObject({
      patch: { needs_human: 1 },
    });
  });

  test("block sets both fields, trimmed; unblock clears them", () => {
    expect(
      plan("building", "blocked", {
        blocked_reason: " CI is down ",
        unblock_condition: "CI up",
      }),
    ).toMatchObject({
      rule: "block",
      patch: { blocked_reason: "CI is down", unblock_condition: "CI up" },
    });
    expect(plan("blocked", "building", {}, "building")).toMatchObject({
      rule: "unblock",
      patch: { blocked_reason: null, unblock_condition: null },
    });
  });

  test("block without both fields is refused", () => {
    expect(
      plan("building", "blocked", { blocked_reason: "why" }),
    ).toMatchObject({
      allowed: false,
      rule: "block",
      reason: "missing_note",
    });
    expect(
      plan("building", "blocked", { unblock_condition: "when" }),
    ).toMatchObject({
      reason: "missing_note",
    });
  });

  test.each<[TicketStatus, TicketStatus]>([
    ["qa_human", "done"],
    ["rework", "done"],
    ["split", "done"],
    ["backlog", "rejected"],
  ])("%s → %s sets closed_at", (from, to) => {
    expect(plan(from, to)).toMatchObject({ patch: { closed_at: NOW } });
  });

  test("the payload carries the evidence and the override note", () => {
    const evidence = {
      plan_path: "docs/p.md",
      worktrees: [
        { id: "W1", base_sha: "abc", files: 1, paths: ["docs/p.md"] },
      ],
    };
    expect(
      planTransition({
        ticket: lawTicket("qa_harness"),
        priorStatus: null,
        to: "qa_human",
        input: { override_note: "checked by hand" },
        now: NOW,
        evidence,
      }),
    ).toMatchObject({
      payload: {
        rule: "pass_harness",
        evidence,
        override_note: "checked by hand",
      },
    });
  });

  test("no edge is refused as the table would", () => {
    expect(plan("done", "backlog")).toEqual({
      allowed: false,
      rule: "no_edge",
      reason: "illegal_transition",
      detail: "done → backlog is not a transition",
    });
  });
});

test("an edge that carries a ticket past an unowed review says where to", () => {
  expect(plan("spiking", "plan_review")).toMatchObject({
    rule: "submit_plan",
    advance: { whenNoGate: "plan_review", to: "planned" },
  });
});
