import { describe, expect, test } from "vitest";
import {
  assembleEvidence,
  bySeverity,
  exitCodeOf,
  gateFailure,
  sourceChangesOf,
  SOURCE_CHANGE_PATHS_MAX,
  type EvidenceFacts,
} from "./evidence.js";
import type { ReviewFinding } from "./findings.js";
import {
  GATE_FAILURE_DETAIL_MAX,
  GateEvidence,
  GateFailure,
  REVIEWER_SEARCH_MAX,
  StoredGateEvidence,
} from "./schemas.js";
import { verdict, type VerdictInput } from "./verdict.js";

describe("gateFailure: a pre-review failure's reason and why", () => {
  const SETTINGS = {
    blocking_severities: ["blocker", "major"],
    base_drift: "fail",
  } satisfies VerdictInput["settings"];
  const considered = {
    role: "code_reviewer",
    executor_id: "local",
    bound: false,
    runners: [
      { runner_id: "a", why: ["needs_output_schema"] },
      { runner_id: "b", why: ["not_certified", "no_reviewer_agent"] },
    ],
  } as const;

  test("keeps the detail and the considered runners; the verdict fails with its reason and detail", () => {
    const f = gateFailure({
      reason: "no_reviewer",
      detail: "  nobody can review  ",
      considered: {
        ...considered,
        runners: considered.runners.map((r) => ({ ...r, why: [...r.why] })),
      },
    });
    expect(f).toEqual({
      reason: "no_reviewer",
      detail: "nobody can review",
      considered,
    });
    expect(StoredGateEvidence.safeParse(f).success).toBe(true);
    expect(verdict({ evidence: f, findings: [], settings: SETTINGS })).toEqual({
      state: "failed",
      reason: "no_reviewer",
      detail: "nobody can review",
    });
  });

  test("a long detail is cut to fit, an empty one left out", () => {
    const long = gateFailure({
      reason: "reviewer_error",
      detail: "x".repeat(5_000),
    });
    expect(long.detail?.length).toBe(GATE_FAILURE_DETAIL_MAX);
    expect(long.detail?.endsWith("…")).toBe(true);
    expect(gateFailure({ reason: "timeout", detail: "  " })).toEqual({
      reason: "timeout",
    });
    expect(gateFailure({ reason: "supervisor_restart" })).toEqual({
      reason: "supervisor_restart",
    });
    expect(
      verdict({
        evidence: { reason: "timeout" },
        findings: [],
        settings: SETTINGS,
      }),
    ).toMatchObject({ detail: "the gate failed before it had evidence" });
  });

  test("the considered runners are capped", () => {
    const runners = Array.from({ length: REVIEWER_SEARCH_MAX + 5 }, (_, n) => ({
      runner_id: `r${n}`,
      why: ["not_enabled" as const],
    }));
    const f = gateFailure({
      reason: "no_reviewer",
      detail: "many",
      considered: { ...considered, runners },
    });
    expect(f.considered?.runners).toHaveLength(REVIEWER_SEARCH_MAX);
  });

  test("a drift keeps full object ids; one that is not drops the drift, never the reason or detail", () => {
    const drift = { base_sha: "a".repeat(40), tip_sha: "c".repeat(64) };
    expect(
      gateFailure({ reason: "base_drift", detail: "moved", drift }),
    ).toEqual({ reason: "base_drift", detail: "moved", drift });
    expect(
      gateFailure({
        reason: "base_drift",
        detail: "moved",
        drift: { base_sha: "main", tip_sha: "c".repeat(40) },
      }),
    ).toEqual({ reason: "base_drift", detail: "moved" });
  });

  test("each structured part is dropped on its own: a bad drift keeps the considered runners, and back", () => {
    const drift = { base_sha: "a".repeat(40), tip_sha: "c".repeat(40) };
    const runners = considered.runners.map((r) => ({ ...r, why: [...r.why] }));
    expect(
      gateFailure({
        reason: "no_reviewer",
        detail: "both",
        considered: { ...considered, runners },
        drift: { base_sha: "main", tip_sha: "c".repeat(40) },
      }),
    ).toEqual({ reason: "no_reviewer", detail: "both", considered });
    expect(
      gateFailure({
        reason: "no_reviewer",
        detail: "both",
        considered: { ...considered, runners: [{ runner_id: "a", why: [] }] },
        drift,
      }),
    ).toEqual({ reason: "no_reviewer", detail: "both", drift });
  });

  test("credentials in a URL never reach the row (Invariant 11): the userinfo is masked", () => {
    const f = gateFailure({
      reason: "reviewer_error",
      detail:
        "unpinnable: fatal: unable to access 'https://someone:tok3n@example.com/r.git/': 403; ssh://deploy@example.com/r.git too",
    });
    expect(f.detail).toBe(
      "unpinnable: fatal: unable to access 'https://***@example.com/r.git/': 403; ssh://***@example.com/r.git too",
    );
    expect(f.detail).not.toContain("tok3n");
    expect(
      gateFailure({ reason: "reviewer_error", detail: "no url, a@b is fine" })
        .detail,
    ).toBe("no url, a@b is fine");
  });

  test("GateFailure stays strict: an unknown field or exclusion is refused", () => {
    expect(
      GateFailure.safeParse({ reason: "no_reviewer", extra: 1 }).success,
    ).toBe(false);
    expect(
      GateFailure.safeParse({
        reason: "no_reviewer",
        considered: {
          ...considered,
          runners: [{ runner_id: "a", why: ["bored"] }],
        },
      }).success,
    ).toBe(false);
  });
});

const finding = (severity: ReviewFinding["severity"]): ReviewFinding => ({
  severity,
  summary: `a ${severity} finding`,
  file: "src/a.ts",
  line: 3,
  category: null,
  detail_md: null,
});

const facts = (o: Partial<EvidenceFacts> = {}): EvidenceFacts => ({
  kind: "code_review",
  exit: { code: 0, signal: null },
  run: { id: "run-1", started_at: 1_000, ended_at: 4_500 },
  session: {
    id: "ses-1",
    runner_id: "reviewer",
    executor_id: "local",
    model: "model-x",
  },
  runnerVersion: "1.0.0",
  costUsd: 0.02,
  artifactPaths: ["/frm/artifacts/gates/g-1/diff.patch"],
  subject: {
    repo_id: "repo-1",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    files: 2,
  },
  findings: [],
  parse: "schema",
  flags: {},
  ...o,
});

describe("exitCodeOf", () => {
  test("the observed code, 0 included", () => {
    expect(exitCodeOf({ code: 0 })).toBe(0);
    expect(exitCodeOf({ code: 3, signal: null })).toBe(3);
  });

  test("a signal is 128 + its POSIX number", () => {
    expect(exitCodeOf({ code: null, signal: "SIGKILL" })).toBe(137);
    expect(exitCodeOf({ signal: "SIGTERM" })).toBe(143);
    expect(exitCodeOf({ signal: "SIGINT" })).toBe(130);
  });

  test("nothing observed, or an unknown signal: never a number (C1)", () => {
    expect(exitCodeOf({ code: null, signal: null })).toBeNull();
    expect(exitCodeOf({})).toBeNull();
    expect(exitCodeOf({ signal: "SIGWHAT" })).toBeNull();
    expect(exitCodeOf({ signal: "toString" })).toBeNull();
    expect(exitCodeOf({ code: 1.5 })).toBeNull();
  });
});

describe("sourceChangesOf", () => {
  const planPaths = { prefixes: ["docs/"], suffixes: [".md"] };

  test("only paths outside laws.plan_paths count", () => {
    expect(
      sourceChangesOf(["docs/spikes/x.md", "README.md", "src/a.ts"], planPaths),
    ).toEqual({ paths: ["src/a.ts"], total: 1 });
  });

  test("a plan-only diff has none", () => {
    expect(sourceChangesOf(["docs/plan.txt"], planPaths)).toEqual({
      paths: [],
      total: 0,
    });
  });

  test("the paths are capped, the total is not", () => {
    const paths = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    const changes = sourceChangesOf(paths, planPaths);
    expect(changes.paths).toHaveLength(SOURCE_CHANGE_PATHS_MAX);
    expect(changes.total).toBe(30);
  });
});

test("bySeverity counts every severity", () => {
  expect(
    bySeverity([finding("major"), finding("major"), finding("nit")]),
  ).toEqual({ blocker: 0, major: 2, minor: 0, nit: 1 });
});

describe("assembleEvidence", () => {
  test("clean facts give schema-valid evidence that passes", () => {
    const e = assembleEvidence(facts());
    expect(GateEvidence.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({
      command: `code_review ${"a".repeat(40)}..${"b".repeat(40)} by reviewer@local session ses-1`,
      exit_code: 0,
      duration_ms: 3_500,
      cost_usd: 0.02,
      findings: { total: 0, parse: "schema" },
    });
    expect(
      verdict({
        evidence: e,
        findings: [],
        settings: {
          blocking_severities: ["blocker", "major"],
          base_drift: "fail",
        },
      }).state,
    ).toBe("passed");
  });

  // a `qa_harness` gate records the project's own harness command as §10.3's `command`
  // — the line an operator reading the evidence has to be able to run — and the run in structure
  // beside it, `binary_reports` included, so a file that could not be scrubbed is named.
  test("a QA gate's own command and run replace the generic line", () => {
    const qa = {
      command: "./scripts/check PROJ-7",
      exit_code: 1,
      started_at: 10,
      ended_at: 20,
      reports: ["/a/qa-reports/out.xml", "/a/qa-reports/shot.png"],
      binary_reports: ["/a/qa-reports/shot.png"],
    };
    const e = assembleEvidence(
      facts({ kind: "qa_harness", commandLine: qa.command, qa }),
    );
    expect(GateEvidence.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ command: qa.command, qa });
    // Without them the generic line and no `qa` block, as every other kind has.
    const plain = assembleEvidence(facts());
    expect(plain).toMatchObject({
      command: expect.stringContaining("code_review"),
    });
    expect(plain).not.toHaveProperty("qa");
  });

  test("findings are totalled by severity", () => {
    const e = assembleEvidence(
      facts({
        findings: [finding("major"), finding("minor")],
        parse: "heuristic",
      }),
    );
    expect(e).toMatchObject({
      findings: {
        total: 2,
        by_severity: { blocker: 0, major: 1, minor: 1, nit: 0 },
        parse: "heuristic",
      },
    });
  });

  test("a signalled reviewer gets 128 + signo, and verdict fails it (C1)", () => {
    const e = assembleEvidence(
      facts({ exit: { code: null, signal: "SIGKILL" } }),
    );
    expect(e).toMatchObject({ exit_code: 137 });
    expect(
      verdict({
        evidence: e,
        findings: [],
        settings: { blocking_severities: ["major"], base_drift: "fail" },
      }),
    ).toMatchObject({ state: "failed", reason: "reviewer_error" });
  });

  test("no observed exit status: a GateFailure, never evidence (C1)", () => {
    expect(
      assembleEvidence(facts({ exit: { code: null, signal: null } })),
    ).toEqual({
      reason: "reviewer_error",
    });
    const timedOut = assembleEvidence(facts({ exit: {}, reason: "timeout" }));
    expect(GateFailure.parse(timedOut)).toEqual({ reason: "timeout" });
  });

  test("the engine's reason, flags and source changes are kept", () => {
    const e = assembleEvidence(
      facts({
        kind: "plan_review",
        reason: "reviewer_error",
        flags: { single_runner_review: true, fallback_from: "bound" },
        sourceChanges: { paths: ["src/a.ts"], total: 1 },
      }),
    );
    expect(e).toMatchObject({
      reason: "reviewer_error",
      flags: { single_runner_review: true, fallback_from: "bound" },
      source_changes: { paths: ["src/a.ts"], total: 1 },
    });
  });

  test("an open run counts no duration and a negative cost is floored", () => {
    expect(
      assembleEvidence(
        facts({ run: { id: "r", started_at: 5, ended_at: null }, costUsd: -1 }),
      ),
    ).toMatchObject({ duration_ms: 0, cost_usd: 0 });
  });
});
