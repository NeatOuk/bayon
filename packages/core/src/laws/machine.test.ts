import { describe, expect, test } from "vitest";
import { GateFailReason } from "../gates/schemas.js";
import {
  BLOCKING,
  DRIFT_ROUNDS_MAX,
  EVIDENCE,
  MERGED,
  NO_MERGE,
  deliveryRow,
  gate,
  lawTicket,
} from "./fixtures.js";
import {
  FAILURE_CLASS,
  MACHINE_RULES,
  MACHINE_STATUSES,
  failReason,
  harnessRule,
  isCodeFailure,
  machineStep,
  type MachineRule,
} from "./machine.js";
import type { TicketStatus } from "./statuses.js";
import { EDGES, ROUND_KINDS } from "./table.js";
import type { GateFact, GateFacts, LawTicket, MergeFacts } from "./types.js";

// The machine steps: which edge a gate's decision settles, from stored facts alone, and
// the failure classification that keeps an infra failure from ever reading as code failing.

const facts = (
  gates: readonly GateFact[],
  o: {
    readonly repos?: readonly string[];
    readonly multiRepo?: boolean;
    readonly lintRepos?: readonly (string | null)[];
    readonly qaConfigured?: boolean;
    readonly driftRoundsMax?: number;
  } = {},
): GateFacts => ({
  gates,
  repos: o.repos ?? [],
  blockingSeverities: BLOCKING,
  multiRepo: o.multiRepo ?? false,
  lintRepos: o.lintRepos ?? [],
  qaConfigured: o.qaConfigured ?? false,
  driftRoundsMax: o.driftRoundsMax ?? DRIFT_ROUNDS_MAX,
});

/** A gate that failed before it had evidence (GateFailure), for `reason`. */
const failed = (
  kind: string,
  reason: GateFailReason,
  o: Partial<GateFact> = {},
): GateFact => gate({ kind, state: "failed", evidence: { reason }, ...o });

/** A reviewed gate that failed on an open major (GateEvidence with its reason). */
const onCode = (kind: string, o: Partial<GateFact> = {}): GateFact =>
  gate({
    kind,
    state: "failed",
    evidence: { ...EVIDENCE, reason: "blocking_findings" },
    openSeverities: ["major"],
    ...o,
  });

const passed = (kind: string, o: Partial<GateFact> = {}): GateFact =>
  gate({ kind, ...o });
const running = (kind: string, o: Partial<GateFact> = {}): GateFact =>
  gate({ kind, state: "running", evidence: null, ...o });

interface Row {
  readonly name: string;
  readonly status: TicketStatus;
  readonly gates: readonly GateFact[];
  readonly ticket?: Partial<LawTicket>;
  /** `ticket_repos`: each owes its own per-repo gate. */
  readonly repos?: readonly string[];
  readonly multiRepo?: boolean;
  readonly lintRepos?: readonly (string | null)[];
  /** The project runs a QA harness: `pass_review` then opens a `qa_harness` gate. */
  readonly qaConfigured?: boolean;
  /** `gates.drift_rounds_max`; 052's 3 by default. */
  readonly driftRoundsMax?: number;
  /** Its deliveries; none by default. */
  readonly merge?: MergeFacts;
  /** The edge taken, or null for a wait. */
  readonly rule: MachineRule | null;
}

const stepOf = (r: Omit<Row, "name" | "rule">) =>
  machineStep({
    ticket: lawTicket(r.status, r.ticket),
    gates: facts(r.gates, {
      ...(r.repos === undefined ? {} : { repos: r.repos }),
      ...(r.multiRepo === undefined ? {} : { multiRepo: r.multiRepo }),
      ...(r.lintRepos === undefined ? {} : { lintRepos: r.lintRepos }),
      ...(r.qaConfigured === undefined ? {} : { qaConfigured: r.qaConfigured }),
      ...(r.driftRoundsMax === undefined
        ? {}
        : { driftRoundsMax: r.driftRoundsMax }),
    }),
    merge: r.merge ?? NO_MERGE,
  });

const ruleOf = (r: Omit<Row, "name" | "rule">): MachineRule | null => {
  const s = stepOf(r);
  return s.take ? s.rule : null;
};

const NON_TRIVIAL = { non_trivial: true } as const;

describe("isCodeFailure: only blocking findings are the code's", () => {
  test("every reason has a class, and only blocking_findings is code", () => {
    expect(FAILURE_CLASS).toEqual({
      blocking_findings: "code",
      timeout: "infra",
      supervisor_restart: "infra",
      no_reviewer: "infra",
      reviewer_error: "infra",
      missing_evidence: "infra",
      base_drift: "stale",
      source_changes: "subject",
      superseded: "superseded",
    });
    expect(Object.keys(FAILURE_CLASS).toSorted()).toEqual(
      [...GateFailReason.options].toSorted(),
    );
  });

  test.each(GateFailReason.options)(
    "%s, before evidence and after it",
    (reason) => {
      const code = reason === "blocking_findings";
      const early = { state: "failed", evidence: { reason } };
      const late = { state: "failed", evidence: { ...EVIDENCE, reason } };
      expect(isCodeFailure(early)).toBe(code);
      expect(isCodeFailure(late)).toBe(code);
      expect(failReason(early.evidence)).toBe(reason);
    },
  );

  test("a gate that did not fail, or whose evidence names no reason, is not a code failure", () => {
    const shapes = [
      { state: "passed", evidence: EVIDENCE },
      {
        state: "passed",
        evidence: { ...EVIDENCE, reason: "blocking_findings" },
      },
      { state: "running", evidence: null },
      { state: "waived", evidence: { reason: "blocking_findings" } },
      { state: "failed", evidence: null },
      { state: "failed", evidence: "not json" },
      { state: "failed", evidence: { reason: "not_a_reason" } },
      { state: "failed", evidence: EVIDENCE },
    ];
    for (const g of shapes)
      expect(isCodeFailure(g), JSON.stringify(g)).toBe(false);
    expect(failReason({ reason: "not_a_reason" })).toBeNull();
  });
});

const ROWS: readonly Row[] = [
  // plan_review → planned
  {
    name: "a passed plan_review approves the plan",
    status: "plan_review",
    gates: [passed("plan_review")],
    ticket: NON_TRIVIAL,
    rule: "approve_plan",
  },
  {
    name: "a plan_review still running waits",
    status: "plan_review",
    gates: [running("plan_review")],
    ticket: NON_TRIVIAL,
    rule: null,
  },
  {
    name: "a plan_review failed on findings waits (revise_plan is not the supervisor's)",
    status: "plan_review",
    gates: [onCode("plan_review")],
    ticket: NON_TRIVIAL,
    rule: null,
  },
  {
    name: "a plan_review whose retry passed after a timeout approves on the latest attempt",
    status: "plan_review",
    gates: [
      failed("plan_review", "timeout"),
      passed("plan_review", { attempt: 2 }),
    ],
    ticket: NON_TRIVIAL,
    rule: "approve_plan",
  },
  {
    name: "a plan_review whose retry is running waits",
    status: "plan_review",
    gates: [
      failed("plan_review", "timeout"),
      running("plan_review", { attempt: 2 }),
    ],
    ticket: NON_TRIVIAL,
    rule: null,
  },
  {
    name: "plan_review with no gate at all waits",
    status: "plan_review",
    gates: [],
    rule: null,
  },
  // code_review → qa_harness
  {
    name: "a trivial ticket's passed code_review passes the round",
    status: "code_review",
    gates: [passed("code_review")],
    rule: "pass_review",
  },
  {
    name: "a non-trivial ticket waits for ce_review",
    status: "code_review",
    gates: [passed("code_review")],
    ticket: NON_TRIVIAL,
    rule: null,
  },
  {
    name: "a non-trivial ticket passes once ce_review has too",
    status: "code_review",
    gates: [passed("code_review"), passed("ce_review")],
    ticket: NON_TRIVIAL,
    rule: "pass_review",
  },
  {
    name: "lint_configured: the round waits for lint_check",
    status: "code_review",
    gates: [passed("code_review")],
    lintRepos: [null],
    rule: null,
  },
  {
    name: "lint_configured: a passed lint_check completes the round",
    status: "code_review",
    gates: [passed("code_review"), passed("lint_check")],
    lintRepos: [null],
    rule: "pass_review",
  },
  {
    name: "multi_repo: a parity_check that failed for no_reviewer holds the round",
    status: "code_review",
    gates: [passed("code_review"), failed("parity_check", "no_reviewer")],
    multiRepo: true,
    rule: null,
  },
  {
    name: "a waived gate counts as settled (decide judges its reason)",
    status: "code_review",
    gates: [
      failed("code_review", "no_reviewer", {
        state: "waived",
        waiveReason: "reviewed by hand",
      }),
    ],
    rule: "pass_review",
  },
  {
    name: "a sibling still running holds a passed code_review",
    status: "code_review",
    gates: [passed("code_review"), running("ce_review")],
    ticket: NON_TRIVIAL,
    rule: null,
  },
  {
    name: "a retry running after a timeout holds the round",
    status: "code_review",
    gates: [
      failed("code_review", "timeout"),
      running("code_review", { attempt: 2 }),
    ],
    rule: null,
  },
  {
    name: "one repo passed and another failed for no_reviewer: nothing",
    status: "code_review",
    gates: [
      passed("code_review", { repoId: "a" }),
      failed("code_review", "no_reviewer", { repoId: "b" }),
    ],
    repos: ["a", "b"],
    rule: null,
  },
  // Per repo, as the laws count (owedRepos): each repo of the ticket owes its own gate.
  {
    name: "multi-repo: r1's code_review passed and r2 has none at all: the round is not passed",
    status: "code_review",
    gates: [passed("code_review", { repoId: "r1" })],
    repos: ["r1", "r2"],
    rule: null,
  },
  {
    name: "multi-repo: both repos' code_review passed: the round is passed",
    status: "code_review",
    gates: [
      passed("code_review", { repoId: "r1" }),
      passed("code_review", { repoId: "r2" }),
    ],
    repos: ["r1", "r2"],
    rule: "pass_review",
  },
  {
    name: "multi-repo, non-trivial: ce_review passed on r1 only, r2 has none: the round is not passed",
    status: "code_review",
    gates: [
      passed("code_review", { repoId: "r1" }),
      passed("code_review", { repoId: "r2" }),
      passed("ce_review", { repoId: "r1" }),
    ],
    repos: ["r1", "r2"],
    ticket: NON_TRIVIAL,
    rule: null,
  },
  {
    name: "lint_configured on two repos: r1's lint_check passed and r2's is missing: the round is not passed",
    status: "code_review",
    gates: [
      passed("code_review", { repoId: "r1" }),
      passed("code_review", { repoId: "r2" }),
      passed("lint_check", { repoId: "r1" }),
    ],
    repos: ["r1", "r2"],
    lintRepos: ["r1", "r2"],
    rule: null,
  },
  {
    name: "lint_configured on r1 only: r2 owes no lint gate, so r1's pass completes the round",
    status: "code_review",
    gates: [
      passed("code_review", { repoId: "r1" }),
      passed("code_review", { repoId: "r2" }),
      passed("lint_check", { repoId: "r1" }),
    ],
    repos: ["r1", "r2"],
    lintRepos: ["r1"],
    rule: "pass_review",
  },
  {
    name: "multi_repo: parity_check is owed once, repo-less, however many repos",
    status: "code_review",
    gates: [
      passed("code_review", { repoId: "r1" }),
      passed("code_review", { repoId: "r2" }),
      passed("parity_check"),
    ],
    repos: ["r1", "r2"],
    multiRepo: true,
    rule: "pass_review",
  },
  {
    name: "a gate for a repo that owes none does not stand in for the one that does",
    status: "code_review",
    gates: [passed("code_review", { repoId: "r9" })],
    rule: null,
  },
  {
    name: "multi-repo plan_review: r2's plan gate missing waits",
    status: "plan_review",
    gates: [passed("plan_review", { repoId: "r1" })],
    repos: ["r1", "r2"],
    ticket: NON_TRIVIAL,
    rule: null,
  },
  {
    name: "an earlier round's failure is not this round's: round 2 passed",
    status: "code_review",
    gates: [
      onCode("code_review"),
      passed("code_review", { attempt: 2, round: 2 }),
    ],
    rule: "pass_review",
  },
  // code_review → review_fix
  {
    name: "code_review failed on an open major, ce_review passed: request_fix",
    status: "code_review",
    gates: [onCode("code_review"), passed("ce_review")],
    ticket: NON_TRIVIAL,
    rule: "request_fix",
  },
  {
    name: "ce_review failed on an open blocker: request_fix",
    status: "code_review",
    gates: [
      passed("code_review"),
      onCode("ce_review", { openSeverities: ["blocker"] }),
    ],
    ticket: NON_TRIVIAL,
    rule: "request_fix",
  },
  {
    name: "a code failure waits while the round's other gate runs",
    status: "code_review",
    gates: [onCode("code_review"), running("ce_review")],
    ticket: NON_TRIVIAL,
    rule: null,
  },
  {
    name: "no_reviewer moves nothing",
    status: "code_review",
    gates: [failed("code_review", "no_reviewer")],
    rule: null,
  },
  {
    name: "no_reviewer carrying an open major still moves nothing (the guard)",
    status: "code_review",
    gates: [
      failed("code_review", "no_reviewer", { openSeverities: ["major"] }),
    ],
    rule: null,
  },
  {
    name: "reviewer_error with the findings a killed reviewer left moves nothing",
    status: "code_review",
    gates: [
      gate({
        kind: "code_review",
        state: "failed",
        evidence: { ...EVIDENCE, exit_code: 137, reason: "reviewer_error" },
        openSeverities: ["blocker"],
      }),
    ],
    rule: null,
  },
  {
    name: "timeout with an open blocker moves nothing",
    status: "code_review",
    gates: [failed("code_review", "timeout", { openSeverities: ["blocker"] })],
    rule: null,
  },
  // a moved base is answered by a fix round, which brings the branch up to date.
  {
    name: "base_drift at pin, no reviewer and no finding: request_fix",
    status: "code_review",
    gates: [failed("code_review", "base_drift")],
    rule: "request_fix",
  },
  {
    name: "base_drift at pin with its informational finding: request_fix",
    status: "code_review",
    gates: [failed("code_review", "base_drift", { openSeverities: ["minor"] })],
    rule: "request_fix",
  },
  {
    name: "base_drift after a review that left only minor and nit findings: request_fix",
    status: "code_review",
    gates: [
      gate({
        kind: "code_review",
        state: "failed",
        evidence: {
          ...EVIDENCE,
          flags: { base_drift: true },
          reason: "base_drift",
        },
        openSeverities: ["minor", "nit"],
      }),
    ],
    rule: "request_fix",
  },
  {
    name: "ce_review drifted while code_review passed: request_fix",
    status: "code_review",
    gates: [passed("code_review"), failed("ce_review", "base_drift")],
    ticket: NON_TRIVIAL,
    rule: "request_fix",
  },
  {
    name: "a drifted gate waits while the round's other gate runs",
    status: "code_review",
    gates: [failed("code_review", "base_drift"), running("ce_review")],
    ticket: NON_TRIVIAL,
    rule: null,
  },
  {
    name: "an earlier round's drift is not this round's: round 2 passed",
    status: "code_review",
    gates: [
      failed("code_review", "base_drift"),
      passed("code_review", { attempt: 2, round: 2 }),
    ],
    rule: "pass_review",
  },
  {
    name: "drift plus an infra failure on another gate: request_fix (the new round asks it again)",
    status: "code_review",
    gates: [
      failed("code_review", "base_drift"),
      failed("ce_review", "no_reviewer"),
    ],
    ticket: NON_TRIVIAL,
    rule: "request_fix",
  },
  {
    name: "a lint_check that drifted while code_review passed: request_fix",
    status: "code_review",
    gates: [passed("code_review"), failed("lint_check", "base_drift")],
    lintRepos: [null],
    rule: "request_fix",
  },
  {
    name: "a drifted gate of a kind no longer required does not send the round back: pass_review",
    status: "code_review",
    gates: [passed("code_review"), failed("ce_review", "base_drift")],
    rule: "pass_review",
  },
  // The cap (gates.drift_rounds_max): a base that keeps moving is the operator's.
  {
    name: "two drifted rounds running, under a cap of 3: request_fix",
    status: "code_review",
    gates: [
      failed("code_review", "base_drift"),
      failed("code_review", "base_drift", { attempt: 2, round: 2 }),
    ],
    rule: "request_fix",
  },
  {
    name: "three drifted rounds running, at a cap of 3: waits for the operator",
    status: "code_review",
    gates: [
      failed("code_review", "base_drift"),
      failed("code_review", "base_drift", { attempt: 2, round: 2 }),
      failed("code_review", "base_drift", { attempt: 3, round: 3 }),
    ],
    rule: null,
  },
  {
    name: "a round in between that did not drift restarts the count",
    status: "code_review",
    gates: [
      failed("code_review", "base_drift"),
      onCode("code_review", { attempt: 2, round: 2 }),
      failed("code_review", "base_drift", { attempt: 3, round: 3 }),
    ],
    rule: "request_fix",
  },
  {
    name: "a cap of 1 stops at the first drift",
    status: "code_review",
    gates: [failed("code_review", "base_drift")],
    driftRoundsMax: 1,
    rule: null,
  },
  {
    name: "blocking findings since resolved or waived leave nothing to fix",
    status: "code_review",
    gates: [onCode("code_review", { openSeverities: [] })],
    rule: null,
  },
  {
    name: "a minor finding open is not a blocker",
    status: "code_review",
    gates: [onCode("code_review", { openSeverities: ["minor", "nit"] })],
    rule: null,
  },
  {
    name: "a lint_check that failed on a blocker starts a fix round",
    status: "code_review",
    gates: [
      passed("code_review"),
      onCode("lint_check", { openSeverities: ["blocker"] }),
    ],
    lintRepos: [null],
    rule: "request_fix",
  },
  {
    name: "a parity_check that failed on a blocker starts a fix round",
    status: "code_review",
    gates: [
      passed("code_review"),
      onCode("parity_check", { openSeverities: ["blocker"] }),
    ],
    multiRepo: true,
    rule: "request_fix",
  },
  {
    name: "a lint_check that failed reviewer_error, blocker and all, moves nothing",
    status: "code_review",
    gates: [
      passed("code_review"),
      failed("lint_check", "reviewer_error", { openSeverities: ["blocker"] }),
    ],
    lintRepos: [null],
    rule: null,
  },
  {
    name: "a parity_check that timed out with a blocker open moves nothing",
    status: "code_review",
    gates: [
      passed("code_review"),
      failed("parity_check", "timeout", { openSeverities: ["blocker"] }),
    ],
    multiRepo: true,
    rule: null,
  },
  {
    name: "a round that failed for no_reviewer does not inherit round 1's code failure",
    status: "code_review",
    gates: [
      onCode("code_review"),
      failed("code_review", "no_reviewer", { attempt: 2, round: 2 }),
    ],
    rule: null,
  },
  {
    name: "a non-required ce_review failed on code while the round passed: both apply, so neither",
    status: "code_review",
    gates: [passed("code_review"), onCode("ce_review")],
    rule: null,
  },
  // qa_harness → qa_human | rework (the M7.5 hook, over a synthetic qa gate)
  {
    name: "a passed qa_harness gate passes the harness",
    status: "qa_harness",
    gates: [passed("qa_harness")],
    rule: "pass_harness",
  },
  {
    name: "a qa_harness gate failed on a blocker fails the harness",
    status: "qa_harness",
    gates: [onCode("qa_harness", { openSeverities: ["blocker"] })],
    rule: "fail_harness",
  },
  {
    name: "a qa_harness gate that failed for no_reviewer moves nothing",
    status: "qa_harness",
    gates: [
      failed("qa_harness", "no_reviewer", { openSeverities: ["blocker"] }),
    ],
    rule: null,
  },
  {
    name: "a qa_harness gate still running moves nothing",
    status: "qa_harness",
    gates: [running("qa_harness")],
    rule: null,
  },
  {
    name: "qa_harness with no QA gate yet (M7.1) moves nothing",
    status: "qa_harness",
    gates: [passed("code_review")],
    rule: null,
  },
  // statuses no gate decides
  {
    name: "a ticket already in review_fix waits",
    status: "review_fix",
    gates: [onCode("code_review")],
    rule: null,
  },
  {
    name: "a blocked ticket waits, whatever its gates say",
    status: "blocked",
    gates: [passed("code_review")],
    rule: null,
  },
];

describe("machineStep: exactly one edge, from stored facts, or nothing", () => {
  test.each(ROWS)("$name", (r) => {
    expect(ruleOf(r)).toBe(r.rule);
  });

  test("the drift cap says why it waits", () => {
    const step = stepOf({
      status: "code_review",
      gates: [
        failed("code_review", "base_drift"),
        failed("code_review", "base_drift", { attempt: 2, round: 2 }),
      ],
      driftRoundsMax: 2,
    });
    expect(step).toEqual({
      take: false,
      why: "the base moved in 2 rounds running; the operator decides",
    });
  });

  test("a wait says why", () => {
    const s = stepOf({
      status: "code_review",
      gates: [passed("code_review"), running("ce_review")],
      ticket: NON_TRIVIAL,
    });
    expect(s).toEqual({ take: false, why: "ce_review still running" });
    const both = stepOf({
      status: "code_review",
      gates: [passed("code_review"), onCode("ce_review")],
    });
    expect(!both.take && both.why).toContain("pass_review and request_fix");
  });

  test("no round kind may still be running when pass_review or request_fix is taken", () => {
    for (const kind of ROUND_KINDS) {
      for (const gates of [[passed("code_review")], [onCode("code_review")]]) {
        const r = {
          status: "code_review" as const,
          gates: [...gates, running(kind, { attempt: 9 })],
        };
        expect(ruleOf(r), kind).toBeNull();
      }
    }
  });

  test("every machine step lands where its row goes, and opens only the QA round", () => {
    const positive: Readonly<Record<MachineRule, Omit<Row, "name" | "rule">>> =
      {
        approve_plan: { status: "plan_review", gates: [passed("plan_review")] },
        pass_review: { status: "code_review", gates: [passed("code_review")] },
        request_fix: { status: "code_review", gates: [onCode("code_review")] },
        pass_harness: { status: "qa_harness", gates: [passed("qa_harness")] },
        fail_harness: { status: "qa_harness", gates: [onCode("qa_harness")] },
        merge_close: { status: "qa_harness", gates: [], merge: MERGED },
      };
    for (const rule of MACHINE_RULES) {
      const edge = EDGES.find((e) => e.rule === rule);
      const s = stepOf(positive[rule]);
      expect(s, rule).toMatchObject({ take: true, rule, to: edge?.to });
      expect(edge?.from, rule).toBe(positive[rule].status);
      // pass_review is the one machine edge that opens anything: the QA gate of the status it
      // enters, which advanceTicket inserts with no command and the engine launches.
      expect(edge?.gates.opens, rule).toEqual(
        rule === "pass_review"
          ? [{ gate: "qa_harness", when: "qa_configured" }]
          : [],
      );
      expect(edge?.advance, rule).toBeUndefined();
    }
  });

  // `pass_harness` and `fail_harness` carry a supersede list (an operator's override must
  // not orphan a running harness), and this is the pin that says the machine can never reach it —
  // every gate-decided rule waits while a gate of the kinds it would supersede is running.
  // `merge_close` is the one machine edge that supersedes on purpose, pinned below.
  test("no gate-decided step can be taken while a gate it would supersede is running", () => {
    const running_: Readonly<Record<MachineRule, GateFact[]>> = {
      approve_plan: [running("plan_review")],
      pass_review: [passed("code_review"), running("code_review")],
      request_fix: [onCode("code_review"), running("lint_check")],
      pass_harness: [passed("qa_harness"), running("qa_harness")],
      fail_harness: [onCode("qa_harness"), running("qa_harness")],
      merge_close: [running("qa_harness")],
    };
    const from: Readonly<Record<MachineRule, TicketStatus>> = {
      approve_plan: "plan_review",
      pass_review: "code_review",
      request_fix: "code_review",
      pass_harness: "qa_harness",
      fail_harness: "qa_harness",
      merge_close: "qa_harness",
    };
    for (const rule of MACHINE_RULES) {
      const kinds = EDGES.find((e) => e.rule === rule)?.gates.supersede ?? [];
      // Every kind a machine edge supersedes is one its own step waits for.
      expect(kinds, rule).not.toBe("all");
      const step = stepOf({ status: from[rule], gates: running_[rule] });
      expect(step.take, rule).toBe(false);
    }
  });
});

test("the machine statuses are where the five machine edges leave from", () => {
  expect(MACHINE_STATUSES).toEqual([
    "plan_review",
    "code_review",
    "qa_harness",
  ]);
});

describe("harnessRule: the QA verdict hook (M7.5)", () => {
  test("pass, fail on the code, or nothing", () => {
    const f = facts([]);
    expect(harnessRule([], f)).toBeNull();
    expect(harnessRule([passed("qa_harness")], f)).toBe("pass_harness");
    expect(harnessRule([onCode("qa_harness")], f)).toBe("fail_harness");
    expect(harnessRule([running("qa_harness")], f)).toBeNull();
    expect(
      harnessRule(
        [failed("qa_harness", "timeout", { openSeverities: ["major"] })],
        f,
      ),
    ).toBeNull();
    // Not per repo: the harness is the project's one command, so one repo-less gate
    // speaks for the ticket however many repos it touches, and a gate opened at a repo is not it.
    const two = facts([], { repos: ["a", "b"] });
    expect(harnessRule([passed("qa_harness")], two)).toBe("pass_harness");
    expect(
      harnessRule([passed("qa_harness", { repoId: "a" })], two),
    ).toBeNull();
    expect(
      harnessRule(
        [
          passed("qa_harness", { repoId: "a" }),
          passed("qa_harness", { repoId: "b" }),
        ],
        two,
      ),
    ).toBeNull();
  });

  // The reviewer errors of §1.5 of the spike, each moving nothing: a gate that failed for any
  // reason but the code's is an infra failure (FAILURE_CLASS), so `isCodeFailure` is false and no
  // fixer is staffed against a bug nothing found (rule, applied to QA).
  test("a reviewer error moves nothing, with or without an open finding", () => {
    const f = facts([]);
    for (const reason of [
      "reviewer_error",
      "no_reviewer",
      "timeout",
      "supervisor_restart",
      "missing_evidence",
      "base_drift",
      "superseded",
    ] as const) {
      expect(harnessRule([failed("qa_harness", reason)], f), reason).toBeNull();
      expect(
        harnessRule(
          [failed("qa_harness", reason, { openSeverities: ["blocker"] })],
          f,
        ),
        `${reason} with a blocker`,
      ).toBeNull();
      expect(
        machineStep({
          ticket: lawTicket("qa_harness"),
          gates: facts([failed("qa_harness", reason)]),
          merge: NO_MERGE,
        }),
        `${reason} step`,
      ).toEqual({
        take: false,
        why: "no QA verdict in the round (none yet, or a failure that is not the code's)",
      });
    }
  });

  // The whole point of the gate: a real pass moves the ticket on with no operator override, and a
  // real failure sends it to rework. `qa_passed` then reads the `qa_runs` row the same
  // decision wrote, which is db's test.
  test("a passed QA gate is pass_harness, a failed one is fail_harness", () => {
    expect(
      machineStep({
        ticket: lawTicket("qa_harness"),
        gates: facts([passed("qa_harness")], { qaConfigured: true }),
        merge: NO_MERGE,
      }),
    ).toEqual({ take: true, rule: "pass_harness", to: "qa_human" });
    expect(
      machineStep({
        ticket: lawTicket("qa_harness"),
        gates: facts([onCode("qa_harness")], { qaConfigured: true }),
        merge: NO_MERGE,
      }),
    ).toEqual({ take: true, rule: "fail_harness", to: "rework" });
  });
});

describe("merge_close: a merged pull request closes the ticket", () => {
  const stepAt = (
    status: TicketStatus,
    merge: MergeFacts,
    gates: GateFact[] = [],
  ) => machineStep({ ticket: lawTicket(status), gates: facts(gates), merge });

  test("from qa_harness, qa_human and rework, once every pull request merged", () => {
    for (const status of ["qa_harness", "qa_human", "rework"] as const) {
      expect(stepAt(status, MERGED), status).toEqual({
        take: true,
        rule: "merge_close",
        to: "done",
      });
    }
  });

  test("over a harness still running: the merge supersedes it", () => {
    expect(stepAt("qa_harness", MERGED, [running("qa_harness")])).toEqual({
      take: true,
      rule: "merge_close",
      to: "done",
    });
    expect(
      EDGES.find((e) => e.rule === "merge_close" && e.from === "qa_harness")
        ?.gates.supersede,
    ).toEqual(["qa_harness"]);
  });

  test("never from a status a merge does not close", () => {
    for (const status of ["building", "code_review", "done"] as const) {
      const s = stepAt(status, MERGED);
      expect(s.take && s.rule, status).not.toBe("merge_close");
    }
  });

  test("a partial merge, a switched-off project, or no pull request waits", () => {
    const partly: MergeFacts = {
      closeOnMerge: true,
      deliveries: [deliveryRow("R1", "merged"), deliveryRow("R2", "pr_open")],
    };
    expect(stepAt("qa_human", partly)).toMatchObject({ take: false });
    expect(stepAt("qa_human", { ...MERGED, closeOnMerge: false })).toEqual({
      take: false,
      why: "this project does not close a ticket when its pull requests merge",
    });
    expect(stepAt("rework", NO_MERGE)).toEqual({
      take: false,
      why: "the ticket has no pull request",
    });
    // A harness with no verdict and no merge still waits on the harness.
    expect(stepAt("qa_harness", partly, [running("qa_harness")])).toEqual({
      take: false,
      why: "qa_harness is still running",
    });
  });
});
