import { describe, expect, test } from "vitest";
import { ROUND_GATE_KINDS } from "../gates/roles.js";
import { TICKET_STATUSES, isTerminal } from "./statuses.js";
import { EDGES, ROUND_KINDS, outgoing, resolveEdge } from "./table.js";

// The §3.2 table's shape: the laws the review asked to be asserted on the table itself.

const exact = EDGES.filter((edge) => edge.from !== "*");
const requires = (rule: string, name: string) =>
  EDGES.find((edge) => edge.rule === rule)?.requires.some(
    (r) => r.kind === "predicate" && r.name === name,
  );

describe("the gate effects (M3)", () => {
  const requiresOf = (rule: string) =>
    EDGES.find((edge) => edge.rule === rule)?.requires ?? [];
  const idleOf = (rule: string) =>
    requiresOf(rule).flatMap((r) => (r.kind === "gate_idle" ? [r.gate] : []));

  test("only submit_plan, request_review, resubmit and pass_review open rounds", () => {
    expect(
      EDGES.filter((edge) => edge.gates.opens.length > 0).map((e) => e.rule),
    ).toEqual(["submit_plan", "request_review", "resubmit", "pass_review"]);
  });

  // A gate a round opens that the exit edge does not wait for is a gate nobody reads; an edge that
  // waits for a gate no round opens is a stalled ticket. `qa_harness` is waited for in the other
  // form the table has: `qa_passed`, which reads the `qa_runs` row the gate's decision
  // writes. Its `when` is the same one fact, `qa_configured`, so the two still cannot disagree —
  // with a harness the gate decides it, without one it is the operator's override, as it always was.
  const waitedForBy = (rule: string): [string, string][] =>
    requiresOf(rule).flatMap((r) =>
      r.kind === "gate_passed"
        ? [[r.gate, r.when] as [string, string]]
        : r.kind === "qa_passed"
          ? [["qa_harness", "qa_configured"] as [string, string]]
          : [],
    );

  test("every kind an edge opens is required, with the same `when`, by the edge out of the status it enters", () => {
    const exits: Record<string, string> = {
      plan_review: "approve_plan",
      code_review: "pass_review",
      qa_harness: "pass_harness",
    };
    for (const edge of EDGES.filter((e) => e.gates.opens.length > 0)) {
      const exit = exits[String(edge.to)] ?? "(none)";
      expect(waitedForBy(exit), `${edge.rule} → ${exit}`).toEqual(
        edge.gates.opens.map((o) => [o.gate, o.when]),
      );
    }
  });

  // Three hand-written lists of one concept, with nothing holding them together: `ROUND_KINDS`
  // (table.ts), the review round's `opens` (the `request_review` row below), and `ROUND_GATE_KINDS`
  // (gates/roles.ts). A kind added to two of them and missed in the third is orphan
  // reviewer with no test failing -- opened by a round, retried after a restart, and superseded by
  // neither request_fix nor pass_review. These are the cross-checks; the assertions below that read
  // ROUND_KINDS on both sides are vacuous for exactly this drift.
  const sorted = (list: readonly string[]): string[] => [...list].sort();
  const opensOf = (rule: string) =>
    EDGES.find((e) => e.rule === rule)?.gates.opens.map((o) => o.gate) ?? [];

  test("every kind the review round opens is a kind the round owns", () => {
    expect(sorted(opensOf("request_review"))).toEqual(sorted(ROUND_KINDS));
    expect(sorted(opensOf("resubmit"))).toEqual(sorted(ROUND_KINDS));
  });

  test("pass_review opens the QA round of the status it enters", () => {
    expect(opensOf("pass_review")).toEqual(["qa_harness"]);
    expect(EDGES.find((e) => e.rule === "pass_review")?.to).toBe("qa_harness");
    // And no code-review kind comes with it: the round it closes is not the round it opens.
    expect(opensOf("pass_review").some((k) => ROUND_KINDS.includes(k))).toBe(
      false,
    );
  });

  test("pass_review supersedes exactly the kinds the round opened", () => {
    const supersede = EDGES.find((e) => e.rule === "pass_review")?.gates
      .supersede;
    expect(supersede).not.toBe("all");
    expect(sorted(supersede === "all" ? [] : (supersede ?? []))).toEqual(
      sorted(opensOf("request_review")),
    );
  });

  // ROUND_GATE_KINDS is what decides retry-after-timeout and `POST /gates/:id/run`. It is every
  // kind some edge opens a round of: the review round's, plus plan_review (a plan round's) and
  // qa_harness (pass_review's). A kind an edge opens and this list misses is a gate the
  // engine refuses to run at all; a kind here that no edge opens is a rerun door onto nothing.
  test("ROUND_GATE_KINDS is exactly the kinds some edge opens a round of", () => {
    const opened = EDGES.flatMap((e) => e.gates.opens.map((o) => o.gate));
    expect(sorted([...new Set(ROUND_GATE_KINDS)])).toEqual(
      sorted([...new Set(opened)]),
    );
    expect(sorted(ROUND_GATE_KINDS)).toEqual(
      sorted([...ROUND_KINDS, "plan_review", "qa_harness"]),
    );
    expect(sorted(opensOf("submit_plan"))).toEqual(["plan_review"]);
  });

  test("request_fix and revise_plan guard exactly the kinds they supersede", () => {
    for (const rule of ["request_fix", "revise_plan"]) {
      const edge = EDGES.find((e) => e.rule === rule);
      const guarded = idleOf(rule);
      expect(guarded.length, rule).toBeGreaterThan(0);
      expect(edge?.gates.supersede, rule).toEqual(guarded);
    }
  });

  test("release, park, reject and split supersede every running gate; nothing else supersedes all", () => {
    expect(
      EDGES.filter((edge) => edge.gates.supersede === "all").map((e) => e.rule),
    ).toEqual(["release", "park", "reject", "split"]);
    // release is a `*` edge, so it leaves code_review and plan_review too: no reviewer stays running.
    expect(resolveEdge("code_review", "handoff_pending", null)?.rule).toBe(
      "release",
    );
    expect(resolveEdge("plan_review", "handoff_pending", null)?.rule).toBe(
      "release",
    );
  });

  test("revise_plan is the one way from plan_review back to spiking", () => {
    expect(resolveEdge("plan_review", "spiking", null)?.rule).toBe(
      "revise_plan",
    );
  });
});

describe("the edge table", () => {
  // `merge_close` is one rule over three statuses: the same actors, requirements and
  // effects on each row, so a reader that finds it by name finds the same law wherever it starts.
  test("rule names are unique, but merge_close's three rows, which agree on everything but `from`", () => {
    const rules = EDGES.map((edge) => edge.rule).filter(
      (rule) => rule !== "merge_close",
    );
    expect(new Set(rules).size).toBe(rules.length);
    const merge = EDGES.filter((edge) => edge.rule === "merge_close");
    expect(merge.map((edge) => edge.from)).toEqual([
      "qa_harness",
      "qa_human",
      "rework",
    ]);
    for (const edge of merge) {
      expect(edge.to).toBe("done");
      expect(edge.actors).toEqual(["supervisor"]);
      expect(edge.requires).toEqual(merge[0]?.requires);
      expect(edge.effects).toEqual({ close: true });
    }
  });

  // Two exact rows share a pair only where their actors are disjoint, so `resolveEdge` can never
  // have two rows to choose between for one actor.
  test("two exact rows share (from, to) only with disjoint actors, and the operator's row comes first", () => {
    const byPair = new Map<string, (typeof exact)[number][]>();
    for (const edge of exact) {
      const key = `${edge.from}→${edge.to}`;
      byPair.set(key, [...(byPair.get(key) ?? []), edge]);
    }
    const shared = [...byPair.entries()].filter(([, rows]) => rows.length > 1);
    expect(
      shared.map(([pair, rows]) => [pair, rows.map((r) => r.rule)]),
    ).toEqual([
      ["qa_human→done", ["pass_human_qa", "merge_close"]],
      ["rework→done", ["finish_rework", "merge_close"]],
    ]);
    for (const [, rows] of shared) {
      const actors = rows.flatMap((r) => r.actors);
      expect(new Set(actors).size).toBe(actors.length);
    }
  });

  test("resolveEdge picks the row that admits the actor, else the pair's first row", () => {
    expect(resolveEdge("qa_human", "done", null)?.rule).toBe("pass_human_qa");
    expect(resolveEdge("qa_human", "done", null, "operator")?.rule).toBe(
      "pass_human_qa",
    );
    expect(resolveEdge("qa_human", "done", null, "orchestrator")?.rule).toBe(
      "pass_human_qa",
    );
    expect(resolveEdge("qa_human", "done", null, "supervisor")?.rule).toBe(
      "merge_close",
    );
    expect(resolveEdge("rework", "done", null, "supervisor")?.rule).toBe(
      "merge_close",
    );
    expect(resolveEdge("qa_harness", "done", null, "operator")?.rule).toBe(
      "merge_close",
    );
    expect(
      outgoing("qa_human", null, "operator").find((o) => o.to === "done")?.edge
        .rule,
    ).toBe("pass_human_qa");
  });

  test("every status has a row into it", () => {
    for (const status of TICKET_STATUSES) {
      expect(
        EDGES.some((edge) => edge.to === status),
        status,
      ).toBe(true);
    }
  });

  test("terminal statuses have no way out; every other status has one", () => {
    for (const from of TICKET_STATUSES) {
      const out = TICKET_STATUSES.filter(
        (to) => resolveEdge(from, to, "building") !== undefined,
      );
      expect(out.length === 0, from).toBe(isTerminal(from));
    }
  });

  test("a `*` row never loops to its own status", () => {
    expect(resolveEdge("blocked", "blocked", null)).toBeUndefined();
    expect(resolveEdge("split", "split", null)).toBeUndefined();
  });

  test("an exact row wins over a `*` row", () => {
    expect(
      resolveEdge("blocked", "handoff_pending", "handoff_pending")?.rule,
    ).toBe("unblock");
    expect(resolveEdge("blocked", "handoff_pending", "building")?.rule).toBe(
      "release",
    );
  });

  test("no edge into prioritized or staffed admits a worker (§3.2)", () => {
    for (const edge of EDGES) {
      const into = [edge.to].flatMap((to) =>
        to === "@prior" ? TICKET_STATUSES : [to],
      );
      if (into.includes("prioritized") || into.includes("staffed")) {
        expect(edge.actors, edge.rule).not.toContain("worker");
      }
    }
  });

  test("every edge into done requires children_closed and sets closed_at", () => {
    const intoDone = EDGES.filter((edge) => edge.to === "done");
    expect(intoDone.map((edge) => edge.rule)).toEqual([
      "pass_human_qa",
      "finish_rework",
      "merge_close",
      "merge_close",
      "merge_close",
      "close_out",
      "close_split",
    ]);
    for (const edge of intoDone) {
      expect(requires(edge.rule, "children_closed"), edge.rule).toBe(true);
      expect(edge.effects.close, edge.rule).toBe(true);
    }
    expect(requires("close_split", "no_active_worktree")).toBe(true);
    expect(requires("close_out", "no_active_worktree")).toBe(true);
  });

  test("close_out is the operator's alone, and must say why", () => {
    const edge = EDGES.find((e) => e.rule === "close_out");
    expect(edge?.from).toBe("parked");
    expect(edge?.actors).toEqual(["operator"]);
    expect(edge?.requires).toContainEqual({ kind: "note", field: "reason" });
  });

  test("the only way from the QA tail back to building follows a failed human QA (§10.4)", () => {
    const qaTail = new Set(["qa_harness", "qa_human", "rework"]);
    const back = EDGES.filter(
      (edge) => edge.to === "building" && qaTail.has(edge.from),
    );
    expect(back.map((edge) => edge.rule)).toEqual(["rebuild"]);
    expect(requires("rebuild", "entered_from_human_qa")).toBe(true);
  });

  test("release and reclaim are the operator's alone: a hand-off never moves the status (plan rule 3)", () => {
    for (const rule of ["release", "reclaim"]) {
      const edge = EDGES.find((e) => e.rule === rule);
      expect(edge?.actors, rule).toEqual(["operator"]);
      expect(edge?.ownOnly, rule).toBe(false);
    }
  });

  test("every row a worker may take is own-only", () => {
    for (const edge of EDGES.filter((e) => e.actors.includes("worker"))) {
      expect(edge.ownOnly, edge.rule).toBe(true);
    }
  });

  test("outgoing lists each target once, in status order, and resolves @prior", () => {
    const out = outgoing("blocked", "handoff_pending");
    expect(out.map((o) => o.to)).toEqual([
      "parked",
      "rejected",
      "handoff_pending",
      "split",
    ]);
    expect(out.find((o) => o.to === "handoff_pending")?.edge.rule).toBe(
      "unblock",
    );
    expect(outgoing("blocked", null).map((o) => o.to)).not.toContain(
      "building",
    );
    expect(outgoing("done", "building")).toEqual([]);
  });
});
