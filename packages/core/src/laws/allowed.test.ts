import { describe, expect, test } from "vitest";
import { ASSUMED_INPUT, allowedTransitions } from "./allowed.js";
import { decide } from "./decide.js";
import {
  OPERATOR,
  ORCH,
  PLAN,
  STRANGER,
  WORKER,
  gate,
  knownGates,
  lawFacts,
  lawTicket,
} from "./fixtures.js";
import { TICKET_STATUSES } from "./statuses.js";
import type { LawFacts } from "./types.js";

// allowedTransitions runs decide per row, so the two can never disagree. The property is checked
// over an exhaustive enumeration: every status, actor, ownership and fact fixture.

const FACTS: readonly LawFacts[] = [
  lawFacts(),
  lawFacts({ worktrees: [], ticketSessions: [] }),
  lawFacts({ children: [{ id: "C1", status: "building" }] }),
  lawFacts({ children: [{ id: "C1", status: "done" }], worktrees: [] }),
  lawFacts({ priorStatus: "qa_human" }),
  lawFacts({ priorStatus: "building" }),
  lawFacts({ priorStatus: "handoff_pending" }),
  lawFacts({
    gates: knownGates([
      gate({ kind: "code_review" }),
      gate({ kind: "plan_review" }),
    ]),
    qa: { state: "known", value: { latest: "passed" } },
  }),
  lawFacts({ plan: { state: "present" }, diff: { state: "deferred" } }),
  lawFacts({ plan: { state: "present" }, diff: { state: "clean", files: 2 } }),
  lawFacts({
    plan: { state: "present" },
    diff: { state: "dirty", paths: ["src/a.ts"], total: 1 },
  }),
  lawFacts({ actorSession: { id: "S9", ticketId: "T2", live: true } }),
];

describe("allowedTransitions", () => {
  test("agrees with decide on every option, and lists every legal target", () => {
    let checked = 0;
    for (const status of TICKET_STATUSES) {
      for (const actor of [OPERATOR, ORCH, WORKER, STRANGER]) {
        for (const facts of FACTS) {
          for (const non_trivial of [false, true]) {
            const ticket = lawTicket(status, { non_trivial, plan_path: PLAN });
            const options = allowedTransitions({ ticket, actor, facts });
            for (const option of options) {
              const d = decide({
                ticket,
                actor,
                facts,
                to: option.to,
                input: ASSUMED_INPUT,
              });
              const allowed = d.allowed || d.reason === "facts_deferred";
              expect(option.allowed).toBe(allowed);
              expect(option.rule).toBe(d.rule);
              checked += 1;
            }
            const listed = new Set(options.map((o) => o.to));
            for (const to of TICKET_STATUSES.filter((s) => !listed.has(s))) {
              const d = decide({
                ticket,
                actor,
                facts,
                to,
                input: ASSUMED_INPUT,
              });
              // split is never listed (it runs through its own endpoint, §7.5). decide refuses it
              // for everyone, but by actor first for one who could never take it at all. Nor is a
              // row only the supervisor takes (merge_close): no API door reaches it.
              expect(d).toMatchObject(
                to === "split"
                  ? { allowed: false }
                  : d.rule === "merge_close"
                    ? { allowed: false, reason: "actor_not_allowed" }
                    : { allowed: false, reason: "illegal_transition" },
              );
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  test("a deferred diff is allowed, marked deferred", () => {
    const options = allowedTransitions({
      ticket: lawTicket("spiking", { plan_path: PLAN }),
      actor: WORKER,
      facts: lawFacts({
        plan: { state: "present" },
        diff: { state: "deferred" },
      }),
    });
    expect(options.find((o) => o.to === "plan_review")).toEqual({
      to: "plan_review",
      rule: "submit_plan",
      allowed: true,
      deferred: ["no_source_changes"],
    });
  });

  test("a refused option carries its reason and detail", () => {
    const options = allowedTransitions({
      ticket: lawTicket("staffed"),
      actor: WORKER,
      facts: lawFacts({ ticketSessions: [] }),
    });
    expect(options.find((o) => o.to === "spiking")).toEqual({
      to: "spiking",
      rule: "start_spike",
      allowed: false,
      reason: "no_session",
      detail: "no live session holds ticket T1",
    });
  });

  test("an option names the notes its form must collect", () => {
    const qaHuman = allowedTransitions({
      ticket: lawTicket("qa_human"),
      actor: OPERATOR,
      facts: lawFacts(),
    });
    expect(qaHuman.find((o) => o.to === "rework")).toMatchObject({
      allowed: true,
      input: ["reason"],
    });
    const harness = (actor: typeof OPERATOR) =>
      allowedTransitions({
        ticket: lawTicket("qa_harness"),
        actor,
        facts: lawFacts(),
      }).find((o) => o.to === "qa_human");
    expect(harness(OPERATOR)).toMatchObject({
      allowed: true,
      input: ["override_note"],
    });
    expect(harness(WORKER)).toMatchObject({
      allowed: false,
      reason: "facts_unavailable",
    });
    expect(harness(WORKER)).not.toHaveProperty("input");
  });

  test("never offers split: it is not implemented, so no actor can take it", () => {
    for (const status of TICKET_STATUSES) {
      for (const actor of [OPERATOR, ORCH, WORKER, STRANGER]) {
        const options = allowedTransitions({
          ticket: lawTicket(status),
          actor,
          facts: lawFacts(),
        });
        expect(options.map((o) => o.to)).not.toContain("split");
      }
    }
  });

  test("a terminal ticket has no options", () => {
    expect(
      allowedTransitions({
        ticket: lawTicket("done"),
        actor: OPERATOR,
        facts: lawFacts(),
      }),
    ).toEqual([]);
  });
});
