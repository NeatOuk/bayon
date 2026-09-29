import { describe, expect, test } from "vitest";
import { decide } from "./decide.js";
import {
  EVIDENCE,
  OPERATOR,
  ORCH,
  OWN_SESSION,
  PLAN,
  POSITIVE,
  STRANGER,
  WORKER,
  gate,
  knownGates,
  lawInput,
  type Case,
} from "./fixtures.js";
import { TICKET_STATUSES, isTerminal, type TicketStatus } from "./statuses.js";
import { EDGES } from "./table.js";
import type { RefusalReason } from "./statuses.js";

// One test per §3.2 law, with its negative cases (the ticket's acceptance criteria).

const refusal = (c: Case) => {
  const decision = decide(lawInput(c));
  if (decision.allowed)
    throw new Error(`expected a refusal, got ${decision.rule}`);
  return decision;
};

const expectRefused = (c: Case, reason: RefusalReason, rule?: string) =>
  expect(refusal(c)).toMatchObject({
    reason,
    ...(rule === undefined ? {} : { rule }),
  });

describe("every rule has a passing case", () => {
  test("the cases cover every rule but split", () => {
    expect(Object.keys(POSITIVE).toSorted()).toEqual(
      [...new Set(EDGES.map((edge) => edge.rule))]
        .filter((rule) => rule !== "split")
        .toSorted(),
    );
  });

  test.each(Object.entries(POSITIVE))("%s", (rule, c) => {
    expect(decide(lawInput(c))).toEqual({ allowed: true, rule });
  });
});

const spike = (facts: Case["facts"]): Case => ({
  status: "staffed",
  to: "spiking",
  facts,
});

describe("L1 staffed → spiking requires a workspace and a session", () => {
  test.each<[string, Case, RefusalReason]>([
    ["no session", spike({ ticketSessions: [] }), "no_session"],
    [
      "an ended session",
      spike({
        ticketSessions: [{ id: OWN_SESSION, ticketId: "T1", live: false }],
      }),
      "no_session",
    ],
    [
      "an inactive worktree",
      spike({
        worktrees: [{ id: "W1", sessionId: OWN_SESSION, active: false }],
      }),
      "no_worktree",
    ],
    [
      "another session's worktree",
      spike({ worktrees: [{ id: "W1", sessionId: "S7", active: true }] }),
      "no_worktree",
    ],
    [
      "a worktree with no session",
      spike({ worktrees: [{ id: "W1", sessionId: null, active: true }] }),
      "no_worktree",
    ],
  ])("%s", (_name, c, reason) => {
    expectRefused(c, reason, "start_spike");
  });
});

const submit = (
  facts: Case["facts"],
  plan_path: string | null = PLAN,
): Case => ({
  status: "spiking",
  to: "plan_review",
  ticket: { plan_path },
  facts: {
    plan: { state: "present" },
    diff: { state: "clean", files: 1 },
    ...facts,
  },
});

describe("L2 spiking → plan_review requires a plan artifact and no source changes", () => {
  test.each<[string, Case, RefusalReason]>([
    ["no plan_path", submit({}, null), "missing_artifact"],
    ["a blank plan_path", submit({}, "  "), "missing_artifact"],
    [
      "the plan was not checked",
      submit({ plan: undefined }),
      "facts_unavailable",
    ],
    [
      "the plan file is absent",
      submit({ plan: { state: "missing", detail: "no docs/spikes/T1.md" } }),
      "missing_artifact",
    ],
    [
      "the worktree is not local",
      submit({
        plan: { state: "unverifiable", detail: "executor is container" },
      }),
      "diff_unverifiable",
    ],
    [
      "the diff was not checked",
      submit({ diff: undefined }),
      "facts_unavailable",
    ],
    [
      "the diff is deferred",
      submit({ diff: { state: "deferred" } }),
      "facts_deferred",
    ],
    [
      "the diff is unverifiable",
      submit({ diff: { state: "unverifiable", detail: "git timed out" } }),
      "diff_unverifiable",
    ],
  ])("%s", (_name, c, reason) => {
    expectRefused(c, reason, "submit_plan");
  });

  test("a source change is refused, naming the paths", () => {
    const one = refusal(
      submit({ diff: { state: "dirty", paths: ["src/x.ts"], total: 1 } }),
    );
    expect(one).toMatchObject({ reason: "source_changes" });
    expect(one.detail).toBe("1 source file(s) changed: src/x.ts");
    const many = refusal(
      submit({
        diff: { state: "dirty", paths: ["a.ts", "b.ts"], total: 25 },
      }),
    );
    expect(many.detail).toBe(
      "25 source file(s) changed: a.ts, b.ts and 23 more",
    );
  });
});

const approve = (facts: Case["facts"], non_trivial = true): Case => ({
  status: "plan_review",
  to: "planned",
  ticket: { non_trivial },
  facts,
});

describe("L3 plan_review → planned requires the plan_review gate when non-trivial", () => {
  test("a trivial ticket never consults the gate", () => {
    expect(decide(lawInput(approve({}, false))).allowed).toBe(true);
  });

  test.each<[string, Case, RefusalReason]>([
    ["M1: gate facts unavailable", approve({}), "facts_unavailable"],
    ["no gate", approve({ gates: knownGates([]) }), "missing_evidence"],
    [
      "a failed gate",
      approve({
        gates: knownGates([gate({ kind: "plan_review", state: "failed" })]),
      }),
      "gate_not_passed",
    ],
    [
      "unresolved findings",
      approve({
        gates: knownGates([
          gate({ kind: "plan_review", openSeverities: ["major", "blocker"] }),
        ]),
      }),
      "unresolved_findings",
    ],
    [
      "passed without evidence",
      approve({
        gates: knownGates([gate({ kind: "plan_review", evidence: {} })]),
      }),
      "missing_evidence",
    ],
    [
      "passed with a null exit code (core's GateEvidence, the one definition)",
      approve({
        gates: knownGates([
          gate({
            kind: "plan_review",
            evidence: { ...EVIDENCE, exit_code: null },
          }),
        ]),
      }),
      "missing_evidence",
    ],
    [
      "passed with only M1's five evidence fields",
      approve({
        gates: knownGates([
          gate({
            kind: "plan_review",
            evidence: {
              command: EVIDENCE.command,
              exit_code: 0,
              duration_ms: EVIDENCE.duration_ms,
              cost_usd: EVIDENCE.cost_usd,
              artifact_paths: EVIDENCE.artifact_paths,
            },
          }),
        ]),
      }),
      "missing_evidence",
    ],
    [
      "passed with only a failure reason",
      approve({
        gates: knownGates([
          gate({ kind: "plan_review", evidence: { reason: "timeout" } }),
        ]),
      }),
      "missing_evidence",
    ],
  ])("%s", (_name, c, reason) => {
    expectRefused(c, reason, "approve_plan");
  });

  test("the latest attempt counts", () => {
    const retried = approve({
      gates: knownGates([
        gate({ kind: "plan_review", state: "passed", attempt: 2 }),
        gate({ kind: "plan_review", state: "failed", attempt: 1 }),
      ]),
    });
    expect(decide(lawInput(retried)).allowed).toBe(true);
    const regressed = approve({
      gates: knownGates([
        gate({ kind: "plan_review", state: "passed", attempt: 1 }),
        gate({ kind: "plan_review", state: "failed", attempt: 2 }),
      ]),
    });
    expectRefused(regressed, "gate_not_passed");
  });
});

describe("M3 gate laws: waivers, findings on every attempt, severities", () => {
  const code = (o: Partial<Parameters<typeof gate>[0]> = {}) =>
    gate({ kind: "code_review", ...o });

  test("a waived gate with a reason passes, even with an open major", () => {
    const waived = review({
      gates: knownGates([
        code({ state: "failed", openSeverities: ["major"] }),
        code({ state: "waived", attempt: 2, waiveReason: "a false alarm" }),
      ]),
    });
    expect(decide(lawInput(waived)).allowed).toBe(true);
  });

  test("a waived gate without a reason does not pass", () => {
    const blank = review({
      gates: knownGates([code({ state: "waived", waiveReason: "  " })]),
    });
    expect(refusal(blank)).toMatchObject({
      reason: "gate_not_passed",
      detail: "code_review was waived without a reason",
    });
  });

  test("an open major on attempt 1 blocks after attempt 2 passes (§10.3)", () => {
    const earlier = review({
      gates: knownGates([
        code({ state: "failed", openSeverities: ["major"] }),
        code({ state: "passed", attempt: 2 }),
      ]),
    });
    expect(refusal(earlier)).toMatchObject({
      reason: "unresolved_findings",
      detail: "code_review has 1 open finding(s) at blocker, major",
    });
  });

  test("a failed round's open major is unresolved_findings; resolved, the gate is still not passed", () => {
    const open = review({
      gates: knownGates([code({ state: "failed", openSeverities: ["major"] })]),
    });
    expectRefused(open, "unresolved_findings", "pass_review");
    const resolved = review({
      gates: knownGates([code({ state: "failed" })]),
    });
    expectRefused(resolved, "gate_not_passed", "pass_review");
  });

  test("only open findings at the blocking severities block", () => {
    const minor = [code({ openSeverities: ["minor", "nit"] })];
    expect(decide(lawInput(review({ gates: knownGates(minor) }))).allowed).toBe(
      true,
    );
    expectRefused(
      review({ gates: knownGates(minor, [], ["minor"]) }),
      "unresolved_findings",
    );
  });

  test("passed with no evidence, or with a failure only, is missing_evidence", () => {
    for (const evidence of [null, { reason: "superseded" }]) {
      expectRefused(
        review({ gates: knownGates([code({ evidence })]) }),
        "missing_evidence",
      );
    }
  });

  test("a running ce_review holds a non-trivial ticket", () => {
    const running = review(
      {
        gates: knownGates([
          code(),
          gate({ kind: "ce_review", state: "running", evidence: null }),
        ]),
      },
      true,
    );
    expect(refusal(running)).toMatchObject({
      reason: "gate_not_passed",
      detail: "ce_review is running",
    });
  });
});

describe("the stale-review guard (gate_idle) and its operator override", () => {
  const runningReview = knownGates([
    gate({ kind: "code_review", state: "running", evidence: null }),
  ]);
  const runningPlan = knownGates([
    gate({ kind: "plan_review", state: "running", evidence: null }),
  ]);

  test.each<[string, Case]>([
    [
      "a worker's request_fix",
      {
        status: "code_review",
        to: "review_fix",
        facts: { gates: runningReview },
      },
    ],
    [
      "the orchestrator's request_fix",
      {
        status: "code_review",
        to: "review_fix",
        actor: ORCH,
        facts: { gates: runningReview },
      },
    ],
    [
      "a worker's revise_plan",
      { status: "plan_review", to: "spiking", facts: { gates: runningPlan } },
    ],
  ])("%s while the review runs → gate_running", (_name, c) => {
    expect(refusal(c)).toMatchObject({
      reason: "gate_running",
      detail: expect.stringContaining("still running"),
    });
  });

  test("the operator passes the guard (its edge supersedes the running gates)", () => {
    for (const c of [
      { status: "code_review", to: "review_fix", gates: runningReview },
      { status: "plan_review", to: "spiking", gates: runningPlan },
    ] as const) {
      const taken = decide(
        lawInput({
          status: c.status,
          to: c.to,
          actor: OPERATOR,
          facts: { gates: c.gates },
        }),
      );
      expect(taken.allowed).toBe(true);
    }
  });

  test("without gate facts a worker's guard refuses; nothing defaults to pass", () => {
    expectRefused(
      { status: "code_review", to: "review_fix" },
      "facts_unavailable",
      "request_fix",
    );
  });
});

const review = (facts: Case["facts"], non_trivial = false): Case => ({
  status: "code_review",
  to: "qa_harness",
  ticket: { non_trivial },
  facts,
});

describe("L4 code_review → qa_harness requires code_review, and ce_review when non-trivial", () => {
  test("code_review is required even on a trivial ticket", () => {
    expectRefused(review({}), "facts_unavailable", "pass_review");
  });

  test("a non-trivial ticket also needs ce_review", () => {
    const codeOnly = knownGates([gate({ kind: "code_review" })]);
    expectRefused(review({ gates: codeOnly }, true), "missing_evidence");
    const both = knownGates([
      gate({ kind: "code_review" }),
      gate({ kind: "ce_review" }),
    ]);
    expect(decide(lawInput(review({ gates: both }, true))).allowed).toBe(true);
  });

  test("every touched repo needs its gate (§3.1)", () => {
    const r1 = gate({ kind: "code_review", repoId: "r1" });
    const r2 = gate({ kind: "code_review", repoId: "r2" });
    const oneRepo = review({ gates: knownGates([r1], ["r1", "r2"]) });
    expect(refusal(oneRepo)).toMatchObject({
      reason: "missing_evidence",
      detail: "no code_review (r2) gate",
    });
    const both = review({ gates: knownGates([r1, r2], ["r1", "r2"]) });
    expect(decide(lawInput(both)).allowed).toBe(true);
  });
});

// `multiRepo` is one fact: the ticket's workspace has more than one repo AND the operator
// turned `gates.parity_check` on. Off — its default — the gate is neither opened nor waited for.
const BLOCKING_SEVERITIES = ["blocker", "major"];
const parityGates = (
  gates: Parameters<typeof knownGates>[0],
  multiRepo: boolean,
) => knownGates(gates, [], BLOCKING_SEVERITIES, multiRepo);

describe("L4b parity_check blocks pass_review only when it is in force", () => {
  const code = gate({ kind: "code_review" });
  const parity = (o: Partial<Parameters<typeof gate>[0]> = {}) =>
    gate({ kind: "parity_check", ...o });

  test("off: code_review alone passes the ticket", () => {
    expect(
      decide(lawInput(review({ gates: parityGates([code], false) }))).allowed,
    ).toBe(true);
  });

  //, the toggle: the round opened while the switch was off, so it opened no parity
  // gate; the operator then turned it on and `pass_review` started asking for one. There is no
  // gate to pass and none to waive either — waiveGate takes a gate id, and there is no row to
  // name — so the detail has to say the only way out, which is a fresh round.
  test("on, with no parity_check gate: refused, and the detail says how to get one", () => {
    const refused = refusal(review({ gates: parityGates([code], true) }));
    expect(refused).toMatchObject({ reason: "missing_evidence" });
    expect(String(refused?.detail)).toContain("no parity_check gate");
    expect(String(refused?.detail)).toContain("request_fix");
    expect(String(refused?.detail)).toContain("resubmit");
  });

  test("on: a running or failed parity_check holds the ticket", () => {
    for (const state of ["running", "failed"] as const) {
      expectRefused(
        review({
          gates: parityGates([code, parity({ state, evidence: null })], true),
        }),
        "gate_not_passed",
        "pass_review",
      );
    }
  });

  test("on: an open blocker finding on it holds the ticket", () => {
    expectRefused(
      review({
        gates: parityGates(
          [code, parity({ state: "failed", openSeverities: ["blocker"] })],
          true,
        ),
      }),
      "unresolved_findings",
      "pass_review",
    );
  });

  test("on: passed lets the ticket through; so does waived with a reason", () => {
    expect(
      decide(lawInput(review({ gates: parityGates([code, parity()], true) })))
        .allowed,
    ).toBe(true);
    const waived = parity({ state: "waived", waiveReason: "one repo only" });
    expect(
      decide(lawInput(review({ gates: parityGates([code, waived], true) })))
        .allowed,
    ).toBe(true);
  });

  test("on: the one repo-less gate answers for every touched repo (§3.1)", () => {
    // ticket_repos names two repos: code_review needs a gate each, parity_check one in total.
    const facts = knownGates(
      [
        gate({ kind: "code_review", repoId: "r1" }),
        gate({ kind: "code_review", repoId: "r2" }),
        parity(),
      ],
      ["r1", "r2"],
      BLOCKING_SEVERITIES,
      true,
    );
    expect(decide(lawInput(review({ gates: facts }))).allowed).toBe(true);
  });
});

// `lintRepos` is one fact, built as `multiRepo` is: the operator turned
// `gates.lint_check` on AND these repos of the ticket declare a `repos.lint_cmd` for the job to
// run. Empty — its default, and the state of every fleet that has configured no lint command — the
// gate is neither opened nor waited for, which is what makes the switch safe to flip. `[null]` is
// the repo-less gate a ticket with no `ticket_repos` opens.
const lintGates = (
  gates: Parameters<typeof knownGates>[0],
  lintConfigured: boolean,
) =>
  knownGates(
    gates,
    [],
    BLOCKING_SEVERITIES,
    false,
    lintConfigured ? [null] : [],
  );

describe("L4d lint_check blocks pass_review only when it is in force", () => {
  const code = gate({ kind: "code_review" });
  const lint = (o: Partial<Parameters<typeof gate>[0]> = {}) =>
    gate({ kind: "lint_check", ...o });

  test("off: code_review alone passes the ticket", () => {
    expect(
      decide(lawInput(review({ gates: lintGates([code], false) }))).allowed,
    ).toBe(true);
  });

  test("on, with no lint_check gate: refused, and the detail says how to get one", () => {
    const refused = refusal(review({ gates: lintGates([code], true) }));
    expect(refused).toMatchObject({ reason: "missing_evidence" });
    expect(String(refused?.detail)).toContain("no lint_check gate");
    expect(String(refused?.detail)).toContain("request_fix");
  });

  test("on: a failing lint_check holds the ticket in code_review", () => {
    expectRefused(
      review({
        gates: lintGates(
          [code, lint({ state: "failed", openSeverities: ["blocker"] })],
          true,
        ),
      }),
      "unresolved_findings",
      "pass_review",
    );
  });

  // The escape hatch a `pinSubject` refusal could never have offered: an agent that genuinely
  // cannot fix the lint failure is not stranded, because the operator has a row to waive.
  test("on: passed lets the ticket through; so does waived with a reason", () => {
    expect(
      decide(lawInput(review({ gates: lintGates([code, lint()], true) })))
        .allowed,
    ).toBe(true);
    const waived = lint({ state: "waived", waiveReason: "generated file" });
    expect(
      decide(lawInput(review({ gates: lintGates([code, waived], true) })))
        .allowed,
    ).toBe(true);
  });

  test("on: it is per repo — every touched repo needs its own lint_check (§3.1)", () => {
    const oneOfTwo = knownGates(
      [
        gate({ kind: "code_review", repoId: "r1" }),
        gate({ kind: "code_review", repoId: "r2" }),
        lint({ repoId: "r1" }),
      ],
      ["r1", "r2"],
      BLOCKING_SEVERITIES,
      false,
      ["r1", "r2"],
    );
    expect(refusal(review({ gates: oneOfTwo }))).toMatchObject({
      reason: "missing_evidence",
      detail: "no lint_check (r2) gate",
    });
  });

  // the fact is per repo, so the edge asks for exactly the gates the round opened. A
  // repo of the ticket that declares no `repos.lint_cmd` is an explicit skip — before this, one
  // repo's command switched the gate on for every repo, and the one with no command failed it.
  test("on for one repo of two: the other is skipped, not owed a gate", () => {
    const only_r1 = knownGates(
      [
        gate({ kind: "code_review", repoId: "r1" }),
        gate({ kind: "code_review", repoId: "r2" }),
        lint({ repoId: "r1" }),
      ],
      ["r1", "r2"],
      BLOCKING_SEVERITIES,
      false,
      ["r1"],
    );
    expect(decide(lawInput(review({ gates: only_r1 }))).allowed).toBe(true);
  });
});

// a conditional gate's requirement is answered by THIS round's gate, never by an
// earlier round's. Before 023 the law asked only whether a gate of the kind had ever existed on the
// ticket, so a requirement switched off for a round and back on afterwards was satisfied by
// evidence for a commit two rounds old.
describe("L4c a gate requirement needs this round's gate, not an earlier round's", () => {
  const codeAt = (round: number) =>
    gate({ kind: "code_review", attempt: round, round });

  // The operator-only sequence, in full: (1) gates.parity_check on and the workspace multi-repo, so
  // round 1 opens parity_check and it passes with evidence; (2) the operator turns the switch off;
  // (3) request_fix → resubmit, so round 2 opens code_review alone; (4) the fix changes the
  // workspace — a gitlink no mirror holds, a moved .gitmodules path; (5) the switch goes back on
  // and pass_review is taken.
  test("parity_check: on → pass → off → resubmit → on refuses pass_review", () => {
    const round1 = [codeAt(1), gate({ kind: "parity_check", round: 1 })];
    const refused = refusal(
      review({ gates: parityGates([...round1, codeAt(2)], true) }),
    );
    expect(refused).toMatchObject({ reason: "missing_evidence" });
    expect(String(refused?.detail)).toContain("current review round (2)");
    // Round 2's own parity_check is what unblocks it — not round 1's, whatever its state.
    const round2Parity = gate({ kind: "parity_check", attempt: 2, round: 2 });
    expect(
      decide(
        lawInput(
          review({
            gates: parityGates([...round1, codeAt(2), round2Parity], true),
          }),
        ),
      ).allowed,
    ).toBe(true);
  });

  // The identical hole, which predates parity_check: mark the ticket trivial, resubmit, mark it
  // non-trivial again, pass. Keyed on `when` rather than on the kind, so one fix closes both.
  test("ce_review: non-trivial → pass → trivial → resubmit → non-trivial refuses pass_review", () => {
    const round1 = [codeAt(1), gate({ kind: "ce_review", round: 1 })];
    const refused = refusal(
      review({ gates: knownGates([...round1, codeAt(2)]) }, true),
    );
    expect(refused).toMatchObject({ reason: "missing_evidence" });
    expect(String(refused?.detail)).toContain("ce_review");
    expect(String(refused?.detail)).toContain("current review round (2)");
    const round2Ce = gate({ kind: "ce_review", attempt: 2, round: 2 });
    expect(
      decide(
        lawInput(
          review({ gates: knownGates([...round1, codeAt(2), round2Ce]) }, true),
        ),
      ).allowed,
    ).toBe(true);
  });

  // `always` is not round-guarded: a round always opens an `always` gate, and the one case where it
  // does not — one of that kind still running from an earlier round — has a truer refusal already.
  test("code_review, still running from an earlier round, refuses as gate_not_passed", () => {
    const running = gate({
      kind: "code_review",
      round: 1,
      state: "running",
      evidence: null,
    });
    const ce = gate({ kind: "ce_review", attempt: 1, round: 2 });
    expect(
      refusal(review({ gates: knownGates([running, ce]) }, true)),
    ).toMatchObject({
      reason: "gate_not_passed",
      detail: "code_review is running",
    });
  });
});

const harness = (c: Partial<Case>): Case => ({
  status: "qa_harness",
  to: "qa_human",
  ...c,
});

describe("L5 the QA tail (§3.2 diagram, §10.4)", () => {
  test.each<[string, Case, RefusalReason]>([
    ["M1: qa facts unavailable", harness({}), "facts_unavailable"],
    [
      "an operator without a note",
      harness({ actor: OPERATOR }),
      "facts_unavailable",
    ],
    [
      "an operator with a blank note",
      harness({ actor: OPERATOR, input: { override_note: " " } }),
      "facts_unavailable",
    ],
    [
      "only the operator may override",
      harness({ actor: ORCH, input: { override_note: "trust me" } }),
      "facts_unavailable",
    ],
    [
      "a failed qa_run",
      harness({
        facts: { qa: { state: "known", value: { latest: "failed" } } },
      }),
      "qa_not_passed",
    ],
    [
      "no qa_run",
      harness({ facts: { qa: { state: "known", value: { latest: null } } } }),
      "qa_not_passed",
    ],
  ])("qa_harness → qa_human: %s", (_name, c, reason) => {
    expectRefused(c, reason, "pass_harness");
  });

  test("a passed qa_run lets the owner through", () => {
    const passed = harness({
      facts: { qa: { state: "known", value: { latest: "passed" } } },
    });
    expect(decide(lawInput(passed)).allowed).toBe(true);
  });

  test("failing human QA needs a reason and the operator", () => {
    const fail: Case = { status: "qa_human", to: "rework", actor: OPERATOR };
    expectRefused(fail, "missing_note", "fail_human_qa");
    expectRefused({ ...fail, input: { reason: "  " } }, "missing_note");
    expectRefused(
      { ...fail, actor: ORCH, input: { reason: "x" } },
      "actor_not_allowed",
    );
  });

  test("only a failed human QA goes back to building", () => {
    const rebuild = (priorStatus: TicketStatus | null): Case => ({
      status: "rework",
      to: "building",
      facts: { priorStatus },
    });
    expect(refusal(rebuild("qa_harness"))).toMatchObject({
      rule: "rebuild",
      reason: "not_from_human_qa",
      detail: expect.stringContaining("qa_harness"),
    });
    expect(refusal(rebuild(null)).detail).toContain("unknown");
  });

  test("closing from QA is the operator's, and waits for children", () => {
    expectRefused(
      { status: "qa_human", to: "done", actor: ORCH },
      "actor_not_allowed",
    );
    expectRefused(
      { status: "rework", to: "done", actor: ORCH },
      "actor_not_allowed",
    );
    expectRefused(
      {
        status: "qa_human",
        to: "done",
        actor: OPERATOR,
        facts: { children: [{ id: "C1", status: "building" }] },
      },
      "children_open",
      "pass_human_qa",
    );
  });
});

describe("L6 who may move a ticket", () => {
  test.each(["prioritize", "staff", "ask_human"])(
    "only the orchestrator or operator may %s",
    (rule) => {
      const c = POSITIVE[rule] as Case;
      expectRefused({ ...c, actor: WORKER }, "actor_not_allowed", rule);
    },
  );

  const workerRules = EDGES.filter((edge) => edge.actors.includes("worker"));

  test.each(workerRules.map((edge) => edge.rule))(
    "a worker may %s its own ticket only",
    (rule) => {
      const c = POSITIVE[rule] as Case;
      // A worker has no QA override: it needs a passed qa_run (only pass_harness reads it).
      const passedQa = {
        qa: { state: "known", value: { latest: "passed" } },
      } as const;
      const own = {
        ...c,
        actor: WORKER,
        input: {},
        facts: { ...c.facts, ...passedQa },
      };
      expect(decide(lawInput(own))).toEqual({ allowed: true, rule });
      expectRefused(
        {
          ...c,
          actor: STRANGER,
          facts: {
            ...c.facts,
            actorSession: { id: "S9", ticketId: "T2", live: true },
          },
        },
        "cross_ticket_write",
        rule,
      );
    },
  );

  test("a worker whose session is unknown owns nothing", () => {
    expectRefused(
      { status: "building", to: "blocked", facts: { actorSession: null } },
      "cross_ticket_write",
    );
  });

  test("a worker may not jump two steps", () => {
    expectRefused(
      { status: "staffed", to: "plan_review" },
      "illegal_transition",
      "no_edge",
    );
  });

  test("a worker may always block its own ticket", () => {
    for (const status of TICKET_STATUSES.filter((s) => !isTerminal(s))) {
      if (status === "blocked") continue;
      expect(
        decide(lawInput({ status, to: "blocked" })).allowed,
        `${status} → blocked`,
      ).toBe(true);
    }
  });

  test("release and reclaim are the operator's: an agent is refused (plan rule 3)", () => {
    for (const actor of [WORKER, ORCH]) {
      expectRefused(
        { status: "building", to: "handoff_pending", actor },
        "actor_not_allowed",
        "release",
      );
      expectRefused(
        {
          status: "handoff_pending",
          to: "building",
          actor,
          facts: { priorStatus: "building" },
        },
        "actor_not_allowed",
        "reclaim",
      );
    }
  });
});

describe("L8 a split parent closes only with its children, and owns no worktree (§7.5)", () => {
  const close = (facts: Case["facts"]): Case => ({
    status: "split",
    to: "done",
    actor: ORCH,
    facts: { worktrees: [], ...facts },
  });

  test("an open child blocks it", () => {
    const open = refusal(
      close({
        children: [
          { id: "C1", status: "done" },
          { id: "C2", status: "building" },
        ],
      }),
    );
    expect(open).toMatchObject({
      rule: "close_split",
      reason: "children_open",
    });
    expect(open.detail).toBe("1 child ticket(s) still open: C2");
  });

  test("done, rejected and parked children are closed", () => {
    const closed = close({
      children: [
        { id: "C1", status: "done" },
        { id: "C2", status: "rejected" },
        { id: "C3", status: "parked" },
      ],
    });
    expect(decide(lawInput(closed)).allowed).toBe(true);
  });

  test("an active worktree blocks it", () => {
    expectRefused(
      close({ worktrees: [{ id: "W1", sessionId: null, active: true }] }),
      "worktree_active",
    );
  });

  test("/transition never splits: the split writer does (M2)", () => {
    expectRefused(
      { status: "building", to: "split", actor: OPERATOR },
      "illegal_transition",
      "split",
    );
  });
});

describe("L9 close_out records work finished outside the QA path", () => {
  const closeOut = (c: Partial<Case> = {}): Case => ({
    status: "parked",
    to: "done",
    actor: OPERATOR,
    facts: { worktrees: [] },
    input: { reason: "reviewed and merged outside Bayon" },
    ...c,
  });

  test("the operator closes a parked ticket by saying why", () => {
    expect(decide(lawInput(closeOut()))).toEqual({
      allowed: true,
      rule: "close_out",
    });
  });

  test("an orchestrator may not: only the operator calls work finished", () => {
    expectRefused(closeOut({ actor: ORCH }), "actor_not_allowed", "close_out");
  });

  test("a reason is required", () => {
    expectRefused(closeOut({ input: {} }), "missing_note", "close_out");
  });

  test("an active worktree blocks it", () => {
    expectRefused(
      closeOut({
        facts: { worktrees: [{ id: "W1", sessionId: null, active: true }] },
      }),
      "worktree_active",
      "close_out",
    );
  });

  test("an open child blocks it", () => {
    expectRefused(
      closeOut({
        facts: { worktrees: [], children: [{ id: "C1", status: "building" }] },
      }),
      "children_open",
      "close_out",
    );
  });
});

describe("edges that do not exist", () => {
  test.each<[string, Case]>([
    [
      "unblock to a status other than the prior one",
      {
        status: "blocked",
        to: "planned",
        actor: ORCH,
        facts: { priorStatus: "building" },
      },
    ],
    [
      "unblock with no prior status",
      {
        status: "blocked",
        to: "building",
        actor: ORCH,
      },
    ],
    ["leave done", { status: "done", to: "backlog", actor: OPERATOR }],
    ["leave rejected", { status: "rejected", to: "parked", actor: OPERATOR }],
    [
      "block a blocked ticket",
      { status: "blocked", to: "blocked", actor: OPERATOR },
    ],
  ])("%s", (_name, c) => {
    expectRefused(c, "illegal_transition", "no_edge");
  });

  test("the refusal names both ends", () => {
    expect(refusal({ status: "done", to: "backlog" }).detail).toBe(
      "done → backlog is not a transition",
    );
  });
});
