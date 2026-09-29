import { err, ok } from "@bayon/core";
import type {
  FindingView,
  GateView,
  RunnerConformanceResult,
  RunnerView,
  TicketDetail,
} from "@bayon/proto";
import { describe, expect, test } from "vitest";
import {
  artifactProblems,
  attemptsOf,
  blockingProblems,
  conformanceProblems,
  evidenceProblems,
  gateProblems,
  refusalProblems,
  resolvedProblems,
  retryProblems,
  roundsProblems,
  type EvidenceWant,
} from "./m3-assertions.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const evidence = (o: Record<string, unknown> = {}) => ({
  command: `code_review ${BASE}..${HEAD} by r-schema@local session s1`,
  exit_code: 0,
  duration_ms: 10,
  cost_usd: 0.01,
  artifact_paths: ["/a/diff.patch", "/a/exit.json"],
  run_id: "run1",
  session_id: "s1",
  runner_id: "r-schema",
  runner_version: "v1",
  executor_id: "local",
  model: "m",
  subject: { repo_id: "repo", base_sha: BASE, head_sha: HEAD, files: 1 },
  findings: {
    total: 0,
    by_severity: { blocker: 0, major: 0, minor: 0, nit: 0 },
    parse: "schema",
  },
  flags: {},
  ...o,
});

const finding = (o: Partial<FindingView> = {}): FindingView => ({
  id: "f1",
  severity: "major",
  category: null,
  file: "add.js",
  line: 2,
  summary: "subtracts",
  detail_md: null,
  status: "open",
  resolution_note: null,
  created_at: 1,
  resolved_by_run_id: null,
  resolved_by: null,
  resolved_at: null,
  waived_by: null,
  waive_reason: null,
  ...o,
});

const gate = (o: Partial<GateView> = {}): GateView => ({
  id: "g1",
  kind: "code_review",
  state: "passed",
  attempt: 1,
  repo_id: null,
  required: true,
  findings_total: 0,
  findings_unresolved: 0,
  waive_reason: null,
  decided_at: 100,
  session_id: "s1",
  started_at: 50,
  reason: null,
  evidence: evidence(),
  findings: [],
  ...o,
});

const want: EvidenceWant = {
  runnerId: "r-schema",
  executorId: "local",
  baseSha: BASE,
  headSha: HEAD,
  findings: 0,
  parse: "schema",
  singleRunner: false,
};

describe("conformanceProblems", () => {
  const summary: RunnerConformanceResult["summary"] = {
    passed: [1, 2],
    failed: [],
    na: [3],
    incomplete: [],
    unverified_caps: [],
    certifiable: true,
    gate_eligible: true,
    unattended_allowed: true,
  };
  const result: RunnerConformanceResult = {
    runner_id: "r",
    executor_id: "local",
    model_id: "r.cheap",
    model: "r-cheap",
    runner_version: "v1",
    report_path: "/h/conformance/r.md",
    stored: true,
    passed_at: 1,
    summary,
    teardown: [],
    compression: false,
  };
  const cert = {
    executor_id: "local",
    model_id: "r.cheap",
    compression: false,
    model: "r-cheap",
    runner_version: "v1",
    suite_version: "s",
    kit_hash: "k",
    caps_hash: "c",
    report_path: "/h/conformance/r.md",
    gate_eligible: true,
    passed_at: 5,
    certified_at: 5,
    decertified_at: null,
    decertified_reason: null,
    summary,
  };
  const view: RunnerView = {
    id: "r",
    kind: "llm_cli",
    adapter: "r",
    version_detected: "v1",
    enabled: true,
    caps: null,
    gate_eligible: true,
    conformance_passed_at: 5,
    certifications: [cert],
    models: [],
    inactive_models: [],
    update: null,
  };

  test("a stored, gate-eligible pair with its report passes", () => {
    expect(conformanceProblems(result, view, "local", true)).toEqual([]);
  });

  test("another model's certificate is not this run's", () => {
    expect(
      conformanceProblems(
        { ...result, model_id: "r.complex" },
        view,
        "local",
        true,
      ),
    ).toEqual([
      "GET /runners: r on local has no certification of model r.complex",
    ]);
  });

  test("each missing fact is named", () => {
    const bad = conformanceProblems(
      {
        ...result,
        stored: false,
        summary: {
          ...summary,
          gate_eligible: false,
          failed: [9],
          incomplete: [14],
        },
      },
      {
        ...view,
        certifications: [
          { ...cert, gate_eligible: false, passed_at: null, decertified_at: 9 },
        ],
      },
      "local",
      false,
    );
    expect(bad).toEqual([
      "r on local: nothing stored, the run is not certifiable",
      "r on local: the result is not gate-eligible",
      "r on local failed 9",
      "r on local left 14 incomplete",
      "r on local: no report at /h/conformance/r.md",
      "GET /runners: r on local is not gate_eligible",
      "GET /runners: r on local has no passed_at",
      "GET /runners: r on local is decertified: no reason",
    ]);
    expect(conformanceProblems(result, undefined, "local", true)).toEqual([
      "GET /runners has no r",
    ]);
    expect(
      conformanceProblems(
        result,
        { ...view, certifications: [] },
        "local",
        true,
      ),
    ).toEqual([
      "GET /runners: r on local has no certification of model r.cheap",
    ]);
    expect(conformanceProblems(result, view, "ctr", true)).toContain(
      "r ran on local, not ctr",
    );
  });
});

describe("gateProblems and attemptsOf", () => {
  test("the attempts of one kind, oldest first", () => {
    const gates = [
      gate({ id: "b", attempt: 2 }),
      gate({ id: "p", kind: "plan_review" }),
      gate({ id: "a", attempt: 1 }),
    ];
    expect(attemptsOf(gates, "code_review").map((g) => g.id)).toEqual([
      "a",
      "b",
    ]);
  });

  test("state and reason", () => {
    const at = { kind: "code_review", attempt: 1 };
    expect(gateProblems(gate(), at, { state: "passed", reason: null })).toEqual(
      [],
    );
    expect(
      gateProblems(undefined, at, { state: "passed", reason: null }),
    ).toEqual(["no code_review attempt 1"]);
    expect(
      gateProblems(gate({ state: "failed", reason: "timeout" }), at, {
        state: "passed",
        reason: null,
      }),
    ).toEqual(["code_review attempt 1 is failed (timeout), expected passed"]);
    expect(
      gateProblems(gate({ state: "failed", reason: "reviewer_error" }), at, {
        state: "failed",
        reason: "blocking_findings",
      }),
    ).toEqual([
      "code_review attempt 1 gives the reason reviewer_error, expected blocking_findings",
    ]);
  });
});

describe("evidenceProblems", () => {
  test("full evidence matching the pin, the reviewer and the findings passes", () => {
    expect(evidenceProblems(gate(), want)).toEqual([]);
    expect(
      evidenceProblems(
        gate({ evidence: evidence({ flags: { single_runner_review: true } }) }),
        { ...want, singleRunner: true },
      ),
    ).toEqual([]);
  });

  test("a missing field is incomplete evidence, never a pass (Invariant 10)", () => {
    const partial = Object.fromEntries(
      Object.entries(evidence()).filter(([key]) => key !== "exit_code"),
    );
    expect(evidenceProblems(gate({ evidence: partial }), want)[0]).toMatch(
      /evidence is incomplete/,
    );
    expect(
      evidenceProblems(gate({ evidence: { reason: "timeout" } }), want),
    ).toHaveLength(1);
  });

  test("each mismatch is named", () => {
    const e = evidence({
      exit_code: 137,
      runner_id: "other",
      executor_id: "ctr",
      session_id: "s9",
      subject: { repo_id: "repo", base_sha: HEAD, head_sha: BASE, files: 1 },
      findings: {
        total: 1,
        by_severity: { blocker: 0, major: 1, minor: 0, nit: 0 },
        parse: "heuristic",
      },
      flags: { single_runner_review: true },
    });
    expect(evidenceProblems(gate({ evidence: e }), want)).toEqual([
      "code_review attempt 1: the reviewer exited 137",
      "code_review attempt 1 was reviewed by other, not r-schema",
      "code_review attempt 1 ran on ctr, not local",
      "code_review attempt 1's evidence names session s9, the gate s1",
      `code_review attempt 1 reviewed ${HEAD}..${BASE}, not ${BASE}..${HEAD}`,
      "code_review attempt 1's evidence counts 1 finding(s), expected 0",
      "code_review attempt 1 was parsed heuristic, not schema",
      "code_review attempt 1: flags.single_runner_review is true, expected false",
    ]);
  });
});

test("blockingProblems: exactly one open finding at the severity, on the file", () => {
  const want1 = { severity: "major", file: "add.js" };
  const failed = gate({
    state: "failed",
    findings_total: 1,
    findings_unresolved: 1,
    findings: [finding()],
  });
  expect(blockingProblems(failed, want1)).toEqual([]);
  expect(
    blockingProblems(
      gate({
        findings_unresolved: 0,
        findings: [
          finding({ severity: "minor", status: "resolved", file: null }),
          finding({ id: "f2" }),
        ],
      }),
      want1,
    ),
  ).toEqual([
    "code_review attempt 1 has 2 finding(s), expected exactly 1",
    "code_review attempt 1 counts 0 unresolved, expected 1",
    "finding f1 is minor, expected major",
    "finding f1 is resolved, expected open",
    "finding f1 is on no file, not add.js",
  ]);
});

test("refusalProblems: the status from the cause, the rule and reason from the wire error", () => {
  const w = { status: 422, rule: "pass_review", reason: "unresolved_findings" };
  // As the api-client builds them: the wire error's fields spread, the HTTP status as the cause.
  const wire = {
    class: "law_refused" as const,
    message: "POST /tickets/1/transition: unresolved",
    retryable: false,
    rule: "pass_review",
    reason: "unresolved_findings",
    cause: { status: 422 },
  };
  expect(refusalProblems(err(wire), w)).toEqual([]);
  expect(refusalProblems(ok({}), w)).toEqual([
    "pass_review was allowed; expected 422 unresolved_findings",
  ]);
  const other = {
    ...wire,
    message: "m",
    reason: "gate_not_passed",
    cause: { status: 409 },
  };
  expect(refusalProblems(err(other), w)).toEqual([
    "pass_review answered 409, expected 422",
    "pass_review was refused pass_review / gate_not_passed, expected pass_review / unresolved_findings: m",
  ]);
  expect(
    refusalProblems(
      err({ class: "internal" as const, message: "down", retryable: true }),
      w,
    )[0],
  ).toBe("pass_review answered no status, expected 422");
});

test("resolvedProblems: resolved by the fixing session's run, with a note", () => {
  const w = { runId: "run7", sessionId: "s7" };
  expect(
    resolvedProblems(
      finding({
        status: "resolved",
        resolved_by_run_id: "run7",
        resolved_by: "session:s7",
        resolution_note: "fixed",
      }),
      w,
    ),
  ).toEqual([]);
  expect(resolvedProblems(undefined, w)).toEqual([
    "the round-1 finding is gone",
  ]);
  expect(resolvedProblems(finding(), w)).toEqual([
    "finding f1 is open, expected resolved",
    "finding f1 names run none, not the fixing run run7",
    "finding f1 was resolved by nobody, not session s7",
    "finding f1 has no resolution note",
  ]);
});

test("roundsProblems reads the view's round count", () => {
  const detail = (review_rounds: number) =>
    ({ economics: { review_rounds } }) as unknown as TicketDetail;
  expect(roundsProblems(detail(2), 2)).toEqual([]);
  expect(roundsProblems(detail(1), 2)).toEqual([
    "review_rounds is 1, expected 2",
  ]);
});

test("artifactProblems: every listed path exists; a reason-only gate lists none", () => {
  const gates = [gate(), gate({ id: "g2", evidence: { reason: "timeout" } })];
  expect(artifactProblems(gates, () => true)).toEqual([]);
  expect(artifactProblems(gates, (p) => p.endsWith(".patch"))).toEqual([
    "code_review attempt 1: /a/exit.json does not exist",
  ]);
  expect(artifactProblems([gates[1] ?? gate()], () => true)).toEqual([
    "no gate carries evidence",
  ]);
});

describe("retryProblems", () => {
  const timedOut = (attempt: number, o: Partial<GateView> = {}) =>
    gate({
      id: `g${attempt}`,
      kind: "plan_review",
      attempt,
      state: "failed",
      reason: "timeout",
      evidence: { reason: "timeout" },
      started_at: attempt * 100,
      decided_at: attempt * 100 + 50,
      ...o,
    });

  test("one timeout, one retry at attempt 2 opened as attempt 1 was decided, and no third", () => {
    expect(
      retryProblems([timedOut(1), timedOut(2, { started_at: 150 })]),
    ).toEqual([]);
  });

  test("no retry, an early retry, a wrong reason and a third attempt are each named", () => {
    expect(retryProblems([timedOut(1)])).toEqual([
      "no plan_review attempt 2: the timeout was not retried",
    ]);
    expect(
      retryProblems([
        timedOut(1),
        timedOut(2, { started_at: 120, reason: "reviewer_error" }),
        timedOut(3),
      ]),
    ).toEqual([
      "attempt 2 started before attempt 1 was decided",
      "plan_review attempt 2 gives the reason reviewer_error, expected timeout",
      "1 attempt(s) after the retry: one retry is the budget (gates.timeout_retries)",
    ]);
    expect(retryProblems([])).toEqual([
      "no gate attempt 1",
      "no gate attempt 2: the timeout was not retried",
    ]);
  });
});
