import { describe, expect, test } from "vitest";
import { ciRequirements } from "./ci.js";
import {
  ciCommand,
  ciEvidence,
  ciFindings,
  ciProgress,
  ciVerdict,
  relevantIn,
  repoProgress,
  type CiRepoRead,
  type CiVerdictInput,
} from "./ci-verdict.js";
import {
  CI_EVIDENCE_CHECKS_MAX,
  CiGateEvidence,
  StoredGateEvidence,
  type CiCheck,
} from "./schemas.js";

// The CI verdict (review CRITICAL 1): each delivered repo judged on its own checks, the
// gate passing only when every repo does, and a repo that reported nothing never a pass.

const MIN = 60_000;
const T0 = 1_000_000;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const check = (
  name: string,
  state: CiCheck["state"],
  url: string | null = null,
): CiCheck => ({ name, state, url });

const repo = (
  repo_id: string,
  checks: readonly CiCheck[],
  sha = repo_id === "b" ? SHA_B : SHA_A,
): CiRepoRead => ({ repo_id, sha, checks });

const REPOS = ["a", "b"];
const at = (
  o: Partial<Omit<CiVerdictInput, "required">> & {
    readonly required?: readonly string[];
  } = {},
): CiVerdictInput => ({
  awaitingPr: false,
  repos: [repo("a", [])],
  startedAt: T0,
  now: T0 + MIN,
  graceMs: 10 * MIN,
  timeoutMs: 60 * MIN,
  ...o,
  required: ciRequirements(o.required ?? [], REPOS),
});

describe("one repo", () => {
  test("no pull request at the head: waits, then times out at the deadline", () => {
    expect(ciVerdict(at({ awaitingPr: true }))).toEqual({ kind: "wait_pr" });
    // No repo at all reads the same: there is nothing to judge, and nothing passes.
    expect(ciVerdict(at({ repos: [] }))).toEqual({ kind: "wait_pr" });
    expect(ciVerdict(at({ awaitingPr: true, now: T0 + 60 * MIN }))).toEqual({
      kind: "infra",
      reason: "timeout",
      detail: "no pull request at the reviewed commit within 60 min",
    });
  });

  test("every check passing passes; neutral and skipped pass too", () => {
    const checks = [
      check("build", "success"),
      check("docs", "neutral"),
      check("lint", "skipped"),
    ];
    expect(ciVerdict(at({ repos: [repo("a", checks)] }))).toEqual({
      kind: "pass",
    });
  });

  test("a failure fails at once with others running, and even past the deadline", () => {
    const repos = [
      repo("a", [check("build", "pending"), check("test", "failure")]),
    ];
    const failed = [
      { repo_id: "a", sha: SHA_A, check: check("test", "failure") },
    ];
    expect(ciVerdict(at({ repos }))).toEqual({ kind: "fail", failed });
    expect(ciVerdict(at({ repos, now: T0 + 90 * MIN }))).toEqual({
      kind: "fail",
      failed,
    });
  });

  test("a failing check that is not required changes nothing", () => {
    const repos = [
      repo("a", [check("build", "success"), check("flaky", "failure")]),
    ];
    expect(ciVerdict(at({ repos, required: ["build"] }))).toEqual({
      kind: "pass",
    });
  });

  test("pending waits with its progress, then times out naming what it waited for", () => {
    const repos = [
      repo("a", [check("build", "success"), check("test", "pending")]),
    ];
    expect(ciVerdict(at({ repos }))).toEqual({
      kind: "wait",
      done: 1,
      total: 2,
    });
    expect(ciVerdict(at({ repos, now: T0 + 60 * MIN }))).toEqual({
      kind: "infra",
      reason: "timeout",
      detail: "CI did not finish within 60 min: still waiting for test",
    });
  });

  test("a required check not reported yet waits, then times out naming it", () => {
    const repos = [repo("a", [check("build", "success")])];
    const required = ["build", "e2e"];
    expect(ciVerdict(at({ repos, required }))).toEqual({
      kind: "wait",
      done: 1,
      total: 2,
    });
    expect(
      ciVerdict(at({ repos, required, now: T0 + 61 * MIN })),
    ).toMatchObject({
      reason: "timeout",
      detail: "CI did not finish within 60 min: still waiting for e2e",
    });
  });

  test("a repo that reported nothing waits through the grace, then is reviewer_error naming it", () => {
    expect(ciVerdict(at({ required: ["build"] }))).toEqual({
      kind: "wait",
      done: 0,
      total: 1,
    });
    expect(ciVerdict(at({ now: T0 + 10 * MIN }))).toEqual({
      kind: "infra",
      reason: "reviewer_error",
      detail: `a reported no CI checks for ${SHA_A.slice(0, 12)} within 10 min: is CI set up for it?`,
    });
  });

  test("a grace longer than the wait: the deadline comes first, as a timeout naming the silent repo", () => {
    expect(ciVerdict(at({ graceMs: 120 * MIN, now: T0 + 60 * MIN }))).toEqual({
      kind: "infra",
      reason: "timeout",
      detail: `CI did not finish within 60 min: a reported no CI checks for ${SHA_A.slice(0, 12)}`,
    });
  });
});

describe("two repos, each judged on its own checks", () => {
  test("B reported nothing: the gate waits, then is reviewer_error naming B — never a pass", () => {
    const repos = [repo("a", [check("build", "success")]), repo("b", [])];
    expect(ciVerdict(at({ repos }))).toEqual({
      kind: "wait",
      done: 1,
      total: 1,
    });
    expect(ciVerdict(at({ repos, now: T0 + 10 * MIN }))).toEqual({
      kind: "infra",
      reason: "reviewer_error",
      detail: `b reported no CI checks for ${SHA_B.slice(0, 12)} within 10 min: is CI set up for it?`,
    });
  });

  test("the same check name in both repos, green in A and red in B: the gate fails on B", () => {
    const repos = [
      repo("a", [check("build", "success")]),
      repo("b", [check("build", "failure")]),
    ];
    expect(ciVerdict(at({ repos, required: ["build"] }))).toEqual({
      kind: "fail",
      failed: [{ repo_id: "b", sha: SHA_B, check: check("build", "failure") }],
    });
  });

  test("an unqualified required name A has and B lacks: B waits for it, then the gate times out", () => {
    const repos = [
      repo("a", [check("build", "success")]),
      repo("b", [check("lint", "success")]),
    ];
    expect(ciVerdict(at({ repos, required: ["build"] }))).toEqual({
      kind: "wait",
      done: 1,
      total: 2,
    });
    expect(
      ciVerdict(at({ repos, required: ["build"], now: T0 + 60 * MIN })),
    ).toEqual({
      kind: "infra",
      reason: "timeout",
      detail: "CI did not finish within 60 min: still waiting for b: build",
    });
  });

  test("a name qualified for A is required in A only: B passes on its own checks", () => {
    const repos = [
      repo("a", [check("e2e", "success")]),
      repo("b", [check("lint", "success"), check("e2e", "failure")]),
    ];
    // Nothing is named for B, so every check B reports counts there: its failing e2e fails the gate.
    expect(ciVerdict(at({ repos, required: ["a:e2e"] }))).toMatchObject({
      kind: "fail",
    });
    const onlyA = [
      repo("a", [check("e2e", "success")]),
      repo("b", [check("lint", "success")]),
    ];
    expect(ciVerdict(at({ repos: onlyA, required: ["a:e2e"] }))).toEqual({
      kind: "pass",
    });
    // …and A must report it.
    const aLacks = [
      repo("a", [check("lint", "success")]),
      repo("b", [check("lint", "success")]),
    ];
    expect(ciVerdict(at({ repos: aLacks, required: ["a:e2e"] }))).toEqual({
      kind: "wait",
      done: 1,
      total: 2,
    });
  });

  test("a required name with a colon that is no repo id is one plain name, required in both", () => {
    const repos = [
      repo("a", [check("ci/lint: eslint", "success")]),
      repo("b", [check("ci/lint: eslint", "success"), check("x", "failure")]),
    ];
    expect(ciVerdict(at({ repos, required: ["ci/lint: eslint"] }))).toEqual({
      kind: "pass",
    });
  });

  test("progress counts across repos", () => {
    const repos = [
      repo("a", [check("build", "success"), check("test", "pending")]),
      repo("b", [check("build", "pending")]),
    ];
    const required = ciRequirements(["build", "a:test"], REPOS);
    expect(repoProgress(repos[1] ?? repo("b", []), required)).toEqual({
      done: 0,
      total: 1,
    });
    expect(ciProgress(repos, required)).toEqual({ done: 1, total: 3 });
    expect(relevantIn(repo("b", [check("x", "success")]), [])).toHaveLength(1);
  });
});

describe("findings, the command line and the evidence", () => {
  test("one blocker per failed check, naming its repo, its short head and its log", () => {
    const [f, g] = ciFindings([
      {
        repo_id: "a",
        sha: SHA_A,
        check: check("test", "failure", "https://forge.test/runs/1"),
      },
      { repo_id: "b", sha: SHA_B, check: check("build", "failure") },
    ]);
    expect(f).toEqual({
      severity: "blocker",
      summary: "CI check failed in a: test",
      file: null,
      line: null,
      category: "qa",
      detail_md: [
        `The CI check \`test\` failed on ${SHA_A.slice(0, 12)} in a.`,
        "Its log: https://forge.test/runs/1",
        "Reproduce it in your worktree, fix it, commit, and request review again.",
      ].join("\n"),
    });
    expect(g?.summary).toBe("CI check failed in b: build");
    expect(g?.detail_md).toContain("The forge gave no link");
  });

  test("the command names the required entries, or says every one", () => {
    expect(ciCommand([])).toBe("ci checks (every check reported)");
    expect(ciCommand(["build", "a:e2e"])).toBe("ci checks build, a:e2e");
  });

  const facts = {
    required: ["build"],
    repos: [
      { ...repo("a", [check("build", "success")]), pr_url: "https://f.test/1" },
      { ...repo("b", [check("build", "success")]), pr_url: "https://f.test/2" },
    ],
    failed: false,
    startedAt: T0,
    now: T0 + 5 * MIN,
    artifactPath: "/frm/gates/g/ci-checks.json",
  };

  test("§10.3's five facts, and each repo's read in its own group; it parses as stored evidence", () => {
    const e = ciEvidence(facts);
    expect(e).toEqual({
      command: "ci checks build",
      exit_code: 0,
      duration_ms: 5 * MIN,
      cost_usd: 0,
      artifact_paths: ["/frm/gates/g/ci-checks.json"],
      ci: {
        repos: [
          {
            repo_id: "a",
            sha: SHA_A,
            pr_url: "https://f.test/1",
            checks: [check("build", "success")],
            total: 1,
          },
          {
            repo_id: "b",
            sha: SHA_B,
            pr_url: "https://f.test/2",
            checks: [check("build", "success")],
            total: 1,
          },
        ],
        required: ["build"],
      },
    });
    expect(CiGateEvidence.safeParse(e).success).toBe(true);
    expect(StoredGateEvidence.safeParse(e).data).toEqual(e);
  });

  test("a failure exits 1; a clock that ran backwards is 0 ms, never negative", () => {
    const e = ciEvidence({ ...facts, failed: true, now: T0 - 1 });
    expect(e.exit_code).toBe(1);
    expect(e.duration_ms).toBe(0);
  });

  test("the row keeps checks in order up to its budget across repos, with each repo's true total", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => check(`c${String(i)}`, "success"));
    const e = ciEvidence({
      ...facts,
      repos: [
        {
          ...repo("a", many(CI_EVIDENCE_CHECKS_MAX - 2)),
          pr_url: "https://f.test/1",
        },
        { ...repo("b", many(5)), pr_url: "https://f.test/2" },
        { ...repo("c", many(3)), pr_url: "https://f.test/3" },
      ],
    });
    expect(e.ci.repos.map((r) => [r.checks.length, r.total])).toEqual([
      [CI_EVIDENCE_CHECKS_MAX - 2, CI_EVIDENCE_CHECKS_MAX - 2],
      [2, 5],
      [0, 3],
    ]);
    expect(CiGateEvidence.safeParse(e).success).toBe(true);
  });

  test("no repo, a group keeping more than its total, or a row over budget is not evidence", () => {
    const e = ciEvidence(facts);
    const [first] = e.ci.repos;
    expect(
      CiGateEvidence.safeParse({ ...e, ci: { ...e.ci, repos: [] } }).success,
    ).toBe(false);
    expect(
      CiGateEvidence.safeParse({
        ...e,
        ci: { ...e.ci, repos: [{ ...first, total: 0 }] },
      }).success,
    ).toBe(false);
    const full = Array.from({ length: CI_EVIDENCE_CHECKS_MAX }, () =>
      check("x", "success"),
    );
    expect(
      CiGateEvidence.safeParse({
        ...e,
        ci: {
          ...e.ci,
          repos: [
            { ...first, checks: full, total: full.length },
            {
              ...first,
              repo_id: "b",
              checks: [check("y", "success")],
              total: 1,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
