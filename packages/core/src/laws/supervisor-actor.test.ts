import { describe, expect, test } from "vitest";
import { decide } from "./decide.js";
import { gate, knownGates, lawFacts, lawTicket } from "./fixtures.js";
import { MACHINE_RULES } from "./machine.js";
import { planTransition } from "./plan.js";
import { TICKET_STATUSES, type TicketStatus } from "./statuses.js";
import { EDGES, type Edge } from "./table.js";
import type { Actor, LawFacts } from "./types.js";

// The supervisor as a law actor. Seven rules, each through its named writer: `block`, the circuit
// breaker's through blockTicket, the five machine steps a gate's
// decision settles, and `merge_close`, a merged pull request's, both through
// advanceTicket. Every other edge refuses it, the operator's own ones among them;
// `unblock` stays the operator's or the orchestrator's.

const SUPERVISOR: Actor = { kind: "supervisor" };
const NOTES = {
  blocked_reason: "circuit breaker: 3 failed runs",
  unblock_condition: "answer human request H1, then unblock",
};

const decideFor = (
  from: TicketStatus,
  to: TicketStatus,
  facts: Partial<LawFacts> = {},
) =>
  decide({
    ticket: lawTicket(from),
    actor: SUPERVISOR,
    to,
    input: NOTES,
    facts: lawFacts({ actorSession: null, ...facts }),
  });

/** Where an edge's row starts and lands, as a concrete pair (`*` and `@prior` resolved). */
const pairOf = (edge: Edge): { from: TicketStatus; to: TicketStatus } => ({
  from: edge.from === "*" ? "building" : edge.from,
  to: edge.to === "@prior" ? "building" : edge.to,
});

describe("the supervisor actor", () => {
  test("it is admitted on exactly seven rules: block, the five machine steps and merge_close", () => {
    expect(
      [
        ...new Set(
          EDGES.filter((edge) => edge.actors.includes("supervisor")).map(
            (edge) => edge.rule,
          ),
        ),
      ].toSorted(),
    ).toEqual(["block", ...MACHINE_RULES].toSorted());
    expect(MACHINE_RULES).toContain("merge_close");
  });

  test("the owner-only rows stay the operator's alone", () => {
    for (const rule of [
      "pass_human_qa",
      "fail_human_qa",
      "finish_rework",
      "close_out",
      "release",
      "reclaim",
    ]) {
      expect(EDGES.find((e) => e.rule === rule)?.actors, rule).toEqual([
        "operator",
      ]);
    }
  });

  test("every other edge refuses it actor_not_allowed", () => {
    const mine = new Set<string>(["block", ...MACHINE_RULES]);
    const theirs = EDGES.filter((edge) => mine.has(edge.rule));
    // The pairs a supervisor row shares resolve to the supervisor's row (qa_human → done and
    // rework → done are merge_close's for it): the operator's rows there are not the supervisor's
    // to be refused.
    const shared = new Set(
      theirs.map((e) => `${String(e.from)}→${String(e.to)}`),
    );
    const others = EDGES.filter(
      (edge) =>
        !mine.has(edge.rule) &&
        !shared.has(`${String(edge.from)}→${String(edge.to)}`),
    );
    expect(others.length).toBe(EDGES.length - theirs.length - 2);
    for (const edge of others) {
      const { from, to } = pairOf(edge);
      expect(TICKET_STATUSES, edge.rule).toContain(from);
      expect(
        decideFor(from, to, { priorStatus: "building" }),
        edge.rule,
      ).toMatchObject({
        allowed: false,
        rule: edge.rule,
        reason: "actor_not_allowed",
      });
    }
  });

  test("it may block an open ticket", () => {
    expect(decideFor("building", "blocked")).toEqual({
      allowed: true,
      rule: "block",
    });
  });

  test("it takes a machine step only as the laws allow, with no operator exemption", () => {
    expect(
      decideFor("code_review", "qa_harness", {
        gates: knownGates([gate({ kind: "code_review" })]),
      }),
    ).toEqual({ allowed: true, rule: "pass_review" });
    expect(
      decideFor("plan_review", "planned", {
        gates: knownGates([gate({ kind: "plan_review" })]),
      }),
    ).toEqual({ allowed: true, rule: "approve_plan" });
    // The stale-review guard holds it as it holds a session: only the operator supersedes.
    const running = knownGates([
      gate({ kind: "ce_review", state: "running", evidence: null }),
    ]);
    expect(
      decideFor("code_review", "review_fix", { gates: running }),
    ).toMatchObject({ allowed: false, reason: "gate_running" });
    // No override for QA: until the QA gate's facts exist (M7.5), pass_harness refuses it.
    expect(decideFor("qa_harness", "qa_human")).toMatchObject({
      allowed: false,
      rule: "pass_harness",
      reason: "facts_unavailable",
    });
    expect(decideFor("qa_harness", "rework")).toEqual({
      allowed: true,
      rule: "fail_harness",
    });
  });

  test("there is no block edge out of a closed ticket, nor into blocked from blocked", () => {
    for (const from of ["done", "rejected", "blocked"] as const) {
      const d = decideFor(from, "blocked");
      expect(d.allowed, from).toBe(false);
      expect(!d.allowed && d.reason, from).toBe("illegal_transition");
    }
  });

  test("the block plan carries both notes as the patch", () => {
    const plan = planTransition({
      ticket: lawTicket("building"),
      priorStatus: null,
      to: "blocked",
      input: NOTES,
      now: 0,
    });
    expect("patch" in plan && plan.patch).toEqual(NOTES);
    const missing = planTransition({
      ticket: lawTicket("building"),
      priorStatus: null,
      to: "blocked",
      input: { blocked_reason: NOTES.blocked_reason },
      now: 0,
    });
    expect("reason" in missing && missing.reason).toBe("missing_note");
  });
});
