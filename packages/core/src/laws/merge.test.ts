import { describe, expect, test } from "vitest";
import { allowedTransitions } from "./allowed.js";
import { decide } from "./decide.js";
import {
  MERGED,
  NO_MERGE,
  OPERATOR,
  OWN_SESSION,
  deliveryRow,
  gate,
  knownGates,
  lawFacts,
  lawTicket,
} from "./fixtures.js";
import { awaitingMerge, unmergedReason } from "./merge.js";
import { planTransition } from "./plan.js";
import { MERGE_STATUSES } from "./table.js";
import type { Actor, LawFacts, MergeFacts } from "./types.js";

// merge_close: a ticket whose pull requests all merged goes to done — taken by the
// supervisor alone, on the laws' own `prs_merged` fact, never by anyone through the API.

const SUPERVISOR: Actor = { kind: "supervisor" };
const ORCH: Actor = { kind: "orchestrator", sessionId: "S9" };
const WORKER: Actor = { kind: "worker", sessionId: OWN_SESSION };

const decideAs = (
  actor: Actor,
  from: (typeof MERGE_STATUSES)[number],
  facts: Partial<LawFacts> = {},
) =>
  decide({
    ticket: lawTicket(from),
    actor,
    to: "done",
    input: {},
    facts: lawFacts({ merge: MERGED, ...facts }),
  });

const merge = (...rows: ReturnType<typeof deliveryRow>[]): MergeFacts => ({
  closeOnMerge: true,
  deliveries: rows,
});

describe("merge_close is the supervisor's alone", () => {
  test("the supervisor takes it from each status once everything merged", () => {
    for (const from of MERGE_STATUSES) {
      expect(decideAs(SUPERVISOR, from), from).toEqual({
        allowed: true,
        rule: "merge_close",
      });
    }
  });

  test("qa_harness → done refuses the operator and every agent", () => {
    for (const actor of [OPERATOR, ORCH, WORKER]) {
      expect(decideAs(actor, "qa_harness"), actor.kind).toMatchObject({
        allowed: false,
        rule: "merge_close",
        reason: "actor_not_allowed",
      });
    }
  });

  test("an agent at qa_human or rework is refused by the operator's own row, merged or not", () => {
    for (const from of ["qa_human", "rework"] as const) {
      for (const actor of [ORCH, WORKER]) {
        expect(decideAs(actor, from), `${actor.kind} ${from}`).toMatchObject({
          allowed: false,
          reason: "actor_not_allowed",
        });
      }
    }
  });

  test("the operator keeps its own rows, which a merge does not change", () => {
    expect(decideAs(OPERATOR, "qa_human")).toEqual({
      allowed: true,
      rule: "pass_human_qa",
    });
    expect(decideAs(OPERATOR, "rework")).toEqual({
      allowed: true,
      rule: "finish_rework",
    });
    const offered = allowedTransitions({
      ticket: lawTicket("qa_harness"),
      actor: OPERATOR,
      facts: lawFacts({ merge: MERGED }),
    }).find((o) => o.to === "done");
    // No API door takes it, so no form offers it.
    expect(offered).toBeUndefined();
    const mine = allowedTransitions({
      ticket: lawTicket("qa_harness"),
      actor: SUPERVISOR,
      facts: lawFacts({ merge: MERGED }),
    }).find((o) => o.to === "done");
    expect(mine).toMatchObject({ rule: "merge_close", allowed: true });
  });

  test("its plan closes the ticket and, from qa_harness, supersedes the harness", () => {
    const plan = planTransition({
      ticket: lawTicket("qa_harness"),
      priorStatus: null,
      to: "done",
      input: {},
      now: 7,
      actor: "supervisor",
    });
    expect(plan).toMatchObject({
      rule: "merge_close",
      patch: { closed_at: 7 },
      gates: { opens: [], supersede: ["qa_harness"] },
    });
    const human = planTransition({
      ticket: lawTicket("qa_human"),
      priorStatus: null,
      to: "done",
      input: {},
      now: 7,
      actor: "supervisor",
    });
    expect(human).toMatchObject({
      rule: "merge_close",
      gates: { opens: [], supersede: [] },
    });
    // No actor: the pair's first row, as every caller before an earlier change had it.
    expect(
      planTransition({
        ticket: lawTicket("qa_human"),
        priorStatus: null,
        to: "done",
        input: {},
        now: 7,
      }),
    ).toMatchObject({ rule: "pass_human_qa" });
  });
});

describe("prs_merged", () => {
  const refusedWith = (m: MergeFacts, facts: Partial<LawFacts> = {}) =>
    decideAs(SUPERVISOR, "qa_human", { merge: m, ...facts });

  test("one merged request of two is not enough", () => {
    expect(
      refusedWith(
        merge(deliveryRow("R1", "merged"), deliveryRow("R2", "pr_open")),
      ),
    ).toMatchObject({ allowed: false, reason: "prs_not_merged" });
  });

  test("a request closed without merging holds it", () => {
    expect(
      refusedWith(
        merge(deliveryRow("R1", "merged"), deliveryRow("R2", "closed")),
      ),
    ).toEqual({
      allowed: false,
      rule: "merge_close",
      reason: "prs_not_merged",
      detail: "1 pull request(s) not merged: R2 (closed)",
    });
  });

  test("a failed delivery holds it, even with every request merged", () => {
    expect(
      refusedWith(
        merge(deliveryRow("R1", "merged"), deliveryRow("R2", "failed", null)),
      ),
    ).toEqual({
      allowed: false,
      rule: "merge_close",
      reason: "prs_not_merged",
      detail: "1 delivery row(s) still failed: R2",
    });
  });

  test("a repo pushed with no request does not hold it", () => {
    expect(
      refusedWith(
        merge(deliveryRow("R1", "merged"), deliveryRow("R2", "pushed", null)),
      ),
    ).toEqual({ allowed: true, rule: "merge_close" });
  });

  test("no request at all, or the switch off, refuses", () => {
    expect(refusedWith(NO_MERGE)).toMatchObject({
      reason: "prs_not_merged",
      detail: "the ticket has no pull request",
    });
    expect(refusedWith(merge(deliveryRow("R1", "pushed", null)))).toMatchObject(
      { reason: "prs_not_merged" },
    );
    expect(refusedWith({ ...MERGED, closeOnMerge: false })).toMatchObject({
      reason: "prs_not_merged",
      detail:
        "this project does not close a ticket when its pull requests merge",
    });
  });

  test("an open child holds it, as on every edge into done", () => {
    expect(
      refusedWith(MERGED, { children: [{ id: "T2", status: "building" }] }),
    ).toMatchObject({ allowed: false, reason: "children_open" });
  });

  test("a running harness does not hold it: the edge supersedes it", () => {
    expect(
      decideAs(SUPERVISOR, "qa_harness", {
        gates: knownGates([
          gate({ kind: "qa_harness", state: "running", evidence: null }),
        ]),
      }),
    ).toEqual({ allowed: true, rule: "merge_close" });
  });
});

describe("awaitingMerge", () => {
  test("every request open, in a project that closes on merge: their urls", () => {
    const m = merge(
      deliveryRow("R1", "pr_open"),
      deliveryRow("R2", "pushed", null),
    );
    expect(awaitingMerge(m)).toEqual(["https://forge.test/o/R1/pull/1"]);
    expect(unmergedReason(m)).not.toBeNull();
  });

  test("anything else: none", () => {
    expect(awaitingMerge(NO_MERGE)).toEqual([]);
    expect(
      awaitingMerge(
        merge(deliveryRow("R1", "pr_open"), deliveryRow("R2", "merged")),
      ),
    ).toEqual([]);
    expect(
      awaitingMerge({
        ...merge(deliveryRow("R1", "pr_open")),
        closeOnMerge: false,
      }),
    ).toEqual([]);
  });
});
