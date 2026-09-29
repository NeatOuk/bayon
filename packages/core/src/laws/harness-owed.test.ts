import { describe, expect, test } from "vitest";
import {
  NO_MERGE,
  deliveryRow,
  gate,
  knownGates,
  lawTicket,
} from "./fixtures.js";
import { HARNESS_OPENS, harnessOwed } from "./harness-owed.js";
import type { TicketStatus } from "./statuses.js";
import { EDGES } from "./table.js";
import type { GateFact, GateFacts, MergeFacts } from "./types.js";

// the QA gate a ticket already at qa_harness is owed — it crossed pass_review while its
// project ran no QA, so no round ever opened one — and every case in which it is not.

/**
 * The shared fixture's facts, overriding only `qaConfigured`: a field `GateFacts` gains elsewhere
 * is then filled by the fixture, and this file compiles either way.
 */
const facts = (gates: readonly GateFact[], qaConfigured = true): GateFacts => {
  const known = knownGates(gates);
  if (known.state !== "known") throw new Error("knownGates is always known");
  return { ...known.value, qaConfigured };
};

const owed = (o: {
  readonly status?: TicketStatus;
  readonly gates?: readonly GateFact[];
  readonly qaConfigured?: boolean;
  readonly qaCi?: boolean;
  readonly merge?: MergeFacts;
}) =>
  harnessOwed({
    ticket: lawTicket(o.status ?? "qa_harness"),
    gates: facts(o.gates ?? [], o.qaConfigured ?? true),
    merge: o.merge ?? NO_MERGE,
    qaCi: o.qaCi ?? false,
  });

/** The review round that took the ticket to qa_harness, with no QA gate in it. */
const REVIEWED = [gate({ kind: "code_review", round: 1 })];

describe("harnessOwed", () => {
  test("a ticket at qa_harness in a QA project, with no QA gate in its round, is owed one", () => {
    expect(owed({ gates: REVIEWED })).toEqual({ owed: true });
    expect(owed({ gates: [] })).toEqual({ owed: true });
  });

  test("what opens is the table's own: pass_review's qa_harness entry", () => {
    const passReview = EDGES.filter((e) => e.rule === "pass_review").flatMap(
      (e) => e.gates.opens,
    );
    expect(HARNESS_OPENS).toEqual(
      passReview.filter((o) => o.gate === "qa_harness"),
    );
    expect(HARNESS_OPENS).toEqual([
      { gate: "qa_harness", when: "qa_configured" },
    ]);
  });

  test.each<TicketStatus>(["code_review", "qa_human", "rework", "blocked"])(
    "a ticket at %s is owed nothing",
    (status) => {
      expect(owed({ status, gates: REVIEWED })).toMatchObject({ owed: false });
    },
  );

  test("a project that runs no QA (none, or pending) is owed nothing", () => {
    expect(owed({ gates: REVIEWED, qaConfigured: false })).toEqual({
      owed: false,
      why: "the ticket's project runs no QA harness",
    });
  });

  test("a QA gate running, in any round, is not owed a second", () => {
    const running = gate({ kind: "qa_harness", state: "running", round: 1 });
    expect(owed({ gates: [...REVIEWED, running] })).toMatchObject({
      owed: false,
    });
  });

  test.each(["passed", "failed", "waived"])(
    "a QA gate already in the round (%s) is never reopened: a rerun is the operator's",
    (state) => {
      const qa = gate({ kind: "qa_harness", state, round: 2 });
      expect(owed({ gates: [...REVIEWED, qa] })).toMatchObject({
        owed: false,
      });
    },
  );

  test("a QA gate of an older round does not count: the current round has none", () => {
    const old = gate({ kind: "qa_harness", state: "passed", round: 1 });
    const review = gate({ kind: "code_review", round: 2 });
    expect(owed({ gates: [old, review] })).toEqual({ owed: true });
  });

  describe("a CI project (qa_mode = 'ci')", () => {
    test("with a pull request delivered, it is owed a CI gate", () => {
      for (const state of ["pr_open", "merged"]) {
        expect(
          owed({
            gates: REVIEWED,
            qaCi: true,
            merge: {
              closeOnMerge: false,
              deliveries: [deliveryRow("R1", state)],
            },
          }),
        ).toEqual({ owed: true });
      }
    });

    test("with no pull request at a known head for every delivered repo, it is owed nothing", () => {
      for (const deliveries of [
        [],
        [deliveryRow("R1", "pushed", null)],
        [deliveryRow("R1", "closed")],
        [deliveryRow("R1", "failed", null)],
        // A pull request with no delivered head: nothing for the CI sweep to judge.
        [deliveryRow("R1", "pr_open", "https://forge.test/o/R1/pull/1", null)],
        // One repo's request, another's still pushed with none: the gate would only wait.
        [deliveryRow("R1", "pr_open"), deliveryRow("R2", "pushed", null)],
      ]) {
        expect(
          owed({
            gates: REVIEWED,
            qaCi: true,
            merge: { closeOnMerge: false, deliveries },
          }),
        ).toEqual({
          owed: false,
          why: "the project's QA is its CI, and not every delivered repo has a pull request at a known head for it to read",
        });
      }
    });

    test("every delivered repo with its request: owed", () => {
      expect(
        owed({
          gates: REVIEWED,
          qaCi: true,
          merge: {
            closeOnMerge: false,
            deliveries: [
              deliveryRow("R1", "pr_open"),
              deliveryRow("R2", "merged"),
            ],
          },
        }),
      ).toEqual({ owed: true });
    });
  });
});
