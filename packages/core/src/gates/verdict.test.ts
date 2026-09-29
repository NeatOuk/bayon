import { describe, expect, test } from "vitest";
import { ciEvidence } from "./ci-verdict.js";
import type { GateEvidence } from "./schemas.js";
import { verdict, type VerdictFinding, type VerdictInput } from "./verdict.js";

const SHA = "a".repeat(40);

const evidence = (o: Partial<GateEvidence> = {}): GateEvidence => ({
  command: "review base..head",
  exit_code: 0,
  duration_ms: 1_200,
  cost_usd: 0.04,
  artifact_paths: ["/frm/gates/g-1/review.json"],
  run_id: "run-1",
  session_id: "session-1",
  runner_id: "reviewer",
  runner_version: "1.2.3",
  executor_id: "local",
  model: "model-x",
  subject: {
    repo_id: "repo-1",
    base_sha: SHA,
    head_sha: "b".repeat(64),
    files: 3,
  },
  findings: {
    total: 1,
    by_severity: { blocker: 0, major: 0, minor: 1, nit: 0 },
    parse: "schema",
  },
  flags: {},
  ...o,
});

const input = (o: Partial<VerdictInput> = {}): VerdictInput => ({
  evidence: evidence(),
  findings: [],
  settings: { blocking_severities: ["blocker", "major"], base_drift: "fail" },
  ...o,
});
const open = (severity: VerdictFinding["severity"]): VerdictFinding => ({
  severity,
  status: "open",
});

describe("verdict: passed", () => {
  test("schema-valid evidence and no findings", () => {
    expect(verdict(input())).toEqual({ state: "passed", evidence: evidence() });
  });

  test("a non-zero observed exit status fails reviewer_error, whatever the findings (C1)", () => {
    for (const exit_code of [1, 137, 143]) {
      expect(verdict(input({ evidence: evidence({ exit_code }) }))).toEqual({
        state: "failed",
        reason: "reviewer_error",
        detail: `the reviewer process exited ${exit_code}`,
      });
    }
  });

  test("a recorded reason wins over the exit status: a killed timeout stays a timeout", () => {
    expect(
      verdict(
        input({ evidence: evidence({ exit_code: 137, reason: "timeout" }) }),
      ),
    ).toMatchObject({ state: "failed", reason: "timeout" });
  });

  test("open findings below the blocking severities, and blocking ones resolved or waived", () => {
    const findings: VerdictFinding[] = [
      open("minor"),
      open("nit"),
      { severity: "blocker", status: "resolved" },
      { severity: "major", status: "waived" },
    ];
    expect(verdict(input({ findings })).state).toBe("passed");
  });

  test("an open major when only blocker blocks", () => {
    const settings = {
      blocking_severities: ["blocker" as const],
      base_drift: "fail" as const,
    };
    expect(verdict(input({ findings: [open("major")], settings })).state).toBe(
      "passed",
    );
  });

  test("base drift under the warn policy, flagged in the evidence", () => {
    const drifted = evidence({
      flags: { base_drift: true, single_runner_review: true },
    });
    expect(
      verdict(
        input({
          evidence: drifted,
          settings: { blocking_severities: [], base_drift: "warn" },
        }),
      ),
    ).toEqual({ state: "passed", evidence: drifted });
  });

  test("source_changes with none changed, and a fallback recorded", () => {
    const e = evidence({
      source_changes: { paths: [], total: 0 },
      flags: { fallback_from: "bound" },
    });
    expect(verdict(input({ evidence: e })).state).toBe("passed");
  });
});

describe("verdict: failed", () => {
  test.each<[string, unknown]>([
    ["no evidence", undefined],
    ["an empty object", {}],
    ["no command", { ...evidence(), command: "" }],
    ["no artifact path", evidence({ artifact_paths: [] })],
    [
      "a short sha",
      evidence({ subject: { ...evidence().subject, base_sha: "abc123" } }),
    ],
    ["a fractional exit code", { ...evidence(), exit_code: 1.5 }],
    // The reviewer process's exit status is observed by the executor, so it is never absent.
    ["a null exit code", { ...evidence(), exit_code: null }],
    ["no exit code", { ...evidence(), exit_code: undefined }],
    [
      "a findings total that is not the sum of by_severity",
      evidence({ findings: { ...evidence().findings, total: 2 } }),
    ],
    [
      "more source paths than their total",
      evidence({ source_changes: { paths: ["a.ts"], total: 0 } }),
    ],
    ["a reason with anything but itself", { reason: "timeout", command: "x" }],
    ["an unknown reason", { reason: "gave_up" }],
  ])("missing_evidence: %s", (_, e) => {
    expect(verdict(input({ evidence: e }))).toMatchObject({
      state: "failed",
      reason: "missing_evidence",
    });
  });

  test("a gate that failed before it had evidence carries only its reason", () => {
    expect(
      verdict(input({ evidence: { reason: "supervisor_restart" } })),
    ).toEqual({
      state: "failed",
      reason: "supervisor_restart",
      detail: "the gate failed before it had evidence",
    });
  });

  test("full evidence that records a failure", () => {
    expect(
      verdict(input({ evidence: evidence({ reason: "timeout" }) })),
    ).toMatchObject({
      state: "failed",
      reason: "timeout",
    });
  });

  test("a plan_review subject with source changes (amendment i)", () => {
    const e = evidence({
      source_changes: { paths: ["src/a.ts", "src/b.ts"], total: 5 },
    });
    expect(verdict(input({ evidence: e }))).toEqual({
      state: "failed",
      reason: "source_changes",
      detail: "5 source file(s) changed: src/a.ts, src/b.ts",
    });
  });

  test("base drift under the fail policy", () => {
    expect(
      verdict(input({ evidence: evidence({ flags: { base_drift: true } }) })),
    ).toMatchObject({
      state: "failed",
      reason: "base_drift",
    });
  });

  test("an open finding at a blocking severity", () => {
    expect(
      verdict(
        input({ findings: [open("minor"), open("major"), open("blocker")] }),
      ),
    ).toEqual({
      state: "failed",
      reason: "blocking_findings",
      detail: "2 open finding(s) at blocker, major",
    });
  });
});

describe("verdict: a CI gate's evidence", () => {
  const ci = (failed = false) =>
    ciEvidence({
      required: [],
      repos: [
        {
          repo_id: "r",
          sha: SHA,
          pr_url: "https://forge.test/pull/1",
          checks: [
            { name: "build", state: failed ? "failure" : "success", url: null },
          ],
        },
      ],
      failed,
      startedAt: 0,
      now: 1_000,
      artifactPath: "/frm/gates/g/ci-checks.json",
    });

  test("every check passed and no finding: passed, with the CI evidence kept", () => {
    expect(verdict(input({ evidence: ci() }))).toEqual({
      state: "passed",
      evidence: ci(),
    });
  });

  test("a failed check is a blocking finding: blocking_findings, before the exit code", () => {
    expect(
      verdict(input({ evidence: ci(true), findings: [open("blocker")] })),
    ).toEqual({
      state: "failed",
      reason: "blocking_findings",
      detail: "1 open finding(s) at blocker, major",
    });
  });

  test("exit 1 with no finding naming the check is reviewer_error, never a pass", () => {
    expect(verdict(input({ evidence: ci(true) }))).toEqual({
      state: "failed",
      reason: "reviewer_error",
      detail:
        "the CI evidence records exit 1 and no finding names a failed check",
    });
  });

  test("a recorded reason fails with it", () => {
    expect(
      verdict(input({ evidence: { ...ci(), reason: "timeout" } })),
    ).toMatchObject({ state: "failed", reason: "timeout" });
  });
});
