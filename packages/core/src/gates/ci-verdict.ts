import { requiredIn, type CiRequirement } from "./ci.js";
import type { ReviewFinding } from "./findings.js";
import { QA_CATEGORY } from "./qa.js";
import {
  CI_EVIDENCE_CHECKS_MAX,
  type CiCheck,
  type CiGateEvidence,
  type CiRepoEvidence,
} from "./schemas.js";

// The CI gate's verdict (review CRITICAL 1), pure: **each delivered repo is judged on
// its own checks**, and the gate passes only when every repo does. Merging the repos' checks into
// one list let a two-repo ticket pass with one repo green and the other silent, and let a green
// `build` in one repo stand in for a required `build` in another. Fail closed instead:
//
//   * a repo passes when it reported at least one check, every name required in it is present, and
//     every check that counts there has settled success, neutral or skipped;
//   * a repo that reported nothing waits until the grace, then is `reviewer_error` naming it —
//     infrastructure, never a pass and never the code's failure;
//   * a failed check that counts in any repo is a blocking finding naming the repo and the check.

/** One repo's read: the head judged, and the checks reported on it. */
export interface CiRepoRead {
  readonly repo_id: string;
  readonly sha: string;
  readonly checks: readonly CiCheck[];
}

/** A check that failed, and where. */
export interface CiFailedCheck {
  readonly repo_id: string;
  readonly sha: string;
  readonly check: CiCheck;
}

export interface CiVerdictInput {
  /**
   * True while some repo of the ticket has no pull request at its current head: nothing was
   * delivered yet, or a new commit has not been pushed since. No checks are read at all.
   */
  readonly awaitingPr: boolean;
  /** Every delivered repo's read; empty reads as no pull request yet. */
  readonly repos: readonly CiRepoRead[];
  /** The project's requirements (core `ciRequirements`); none: every check a repo reports counts. */
  readonly required: readonly CiRequirement[];
  /** The gate's `started_at`: the grace and the deadline both run from it. */
  readonly startedAt: number;
  readonly now: number;
  /** `qa.ci_grace_ms`: how long a repo may report nothing at all. */
  readonly graceMs: number;
  /** `qaCiTimeoutOf(qa_ci_timeout_ms)`: how long the gate waits in all. */
  readonly timeoutMs: number;
}

/** How far CI has got: checks that count and have settled, of those that count or are missing. */
export interface CiProgress {
  readonly done: number;
  readonly total: number;
}

export type CiVerdict =
  | { readonly kind: "wait_pr" }
  | ({ readonly kind: "wait" } & CiProgress)
  | { readonly kind: "pass" }
  | { readonly kind: "fail"; readonly failed: readonly CiFailedCheck[] }
  | {
      readonly kind: "infra";
      readonly reason: "timeout" | "reviewer_error";
      readonly detail: string;
    };

/** The states a check has settled in without failing. */
const PASSING: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

const sha12 = (sha: string): string => sha.slice(0, 12);

/** The checks that count in `repo`: the names required there, or every one when none is. */
export function relevantIn(
  repo: CiRepoRead,
  required: readonly CiRequirement[],
): readonly CiCheck[] {
  const names = requiredIn(required, repo.repo_id);
  return names.length === 0
    ? repo.checks
    : repo.checks.filter((c) => names.includes(c.name));
}

/** The names required in `repo` that it has not reported yet. */
const missingIn = (
  repo: CiRepoRead,
  required: readonly CiRequirement[],
): readonly string[] =>
  requiredIn(required, repo.repo_id).filter(
    (name) => !repo.checks.some((c) => c.name === name),
  );

/** One repo's progress: its checks that count and have settled, of those plus its missing names. */
export function repoProgress(
  repo: CiRepoRead,
  required: readonly CiRequirement[],
): CiProgress {
  const relevant = relevantIn(repo, required);
  return {
    done: relevant.filter((c) => c.state !== "pending").length,
    total: relevant.length + missingIn(repo, required).length,
  };
}

/** The gate's progress: every repo's, summed. */
export const ciProgress = (
  repos: readonly CiRepoRead[],
  required: readonly CiRequirement[],
): CiProgress =>
  repos
    .map((r) => repoProgress(r, required))
    .reduce((a, b) => ({ done: a.done + b.done, total: a.total + b.total }), {
      done: 0,
      total: 0,
    });

const minutes = (ms: number): string =>
  `${String(Math.round(ms / 60_000))} min`;

/** A repo's name in a message: only when there are several to tell apart. */
const where = (repo: CiRepoRead, several: boolean): string =>
  several ? `${repo.repo_id}: ` : "";

/**
 * What the checks mean for the gate, in this order: no pull request yet waits (or times out); a
 * failure that counts in any repo is decided at once, even with others still running, because it
 * is the code's answer and a fix round can start; a repo that reported nothing waits through the
 * grace and is then `reviewer_error`; a required check still running or not reported in some repo
 * waits (or times out at the deadline); only when every repo passes does the gate pass.
 */
export function ciVerdict(i: CiVerdictInput): CiVerdict {
  const late = i.now >= i.startedAt + i.timeoutMs;
  if (i.awaitingPr || i.repos.length === 0) {
    return late
      ? {
          kind: "infra",
          reason: "timeout",
          detail: `no pull request at the reviewed commit within ${minutes(i.timeoutMs)}`,
        }
      : { kind: "wait_pr" };
  }
  const failed = i.repos.flatMap((repo) =>
    relevantIn(repo, i.required)
      .filter((c) => c.state === "failure")
      .map((check) => ({ repo_id: repo.repo_id, sha: repo.sha, check })),
  );
  if (failed.length > 0) return { kind: "fail", failed };
  const silent = i.repos.filter((r) => r.checks.length === 0);
  if (silent.length > 0) {
    const said = silent
      .map((r) => `${r.repo_id} reported no CI checks for ${sha12(r.sha)}`)
      .join("; ");
    if (i.now >= i.startedAt + i.graceMs) {
      return {
        kind: "infra",
        reason: "reviewer_error",
        detail: `${said} within ${minutes(i.graceMs)}: is CI set up for it?`,
      };
    }
    if (late) {
      return {
        kind: "infra",
        reason: "timeout",
        detail: `CI did not finish within ${minutes(i.timeoutMs)}: ${said}`,
      };
    }
    return { kind: "wait", ...ciProgress(i.repos, i.required) };
  }
  const several = i.repos.length > 1;
  const waiting = i.repos.flatMap((repo) =>
    [
      ...missingIn(repo, i.required),
      ...relevantIn(repo, i.required)
        .filter((c) => !PASSING.has(c.state))
        .map((c) => c.name),
    ].map((name) => `${where(repo, several)}${name}`),
  );
  if (waiting.length > 0) {
    return late
      ? {
          kind: "infra",
          reason: "timeout",
          detail: `CI did not finish within ${minutes(i.timeoutMs)}: still waiting for ${waiting.join(", ")}`,
        }
      : { kind: "wait", ...ciProgress(i.repos, i.required) };
  }
  return { kind: "pass" };
}

/** The gate's command line, as §10.3 evidence and `qa_runs.command` record it. */
export const ciCommand = (required: readonly string[]): string =>
  required.length === 0
    ? "ci checks (every check reported)"
    : `ci checks ${required.join(", ")}`;

/**
 * One blocking finding per failed check, naming its repo, its check, its commit and
 * its link when the forge gave one on its own host. This is what the fix session reads, so it says
 * what to do.
 */
export const ciFindings = (failed: readonly CiFailedCheck[]): ReviewFinding[] =>
  failed.map(({ repo_id, sha, check }) => ({
    severity: "blocker",
    summary: `CI check failed in ${repo_id}: ${check.name}`,
    file: null,
    line: null,
    category: QA_CATEGORY,
    detail_md: [
      `The CI check \`${check.name}\` failed on ${sha12(sha)} in ${repo_id}.`,
      check.url === null
        ? "The forge gave no link to its log on its own host."
        : `Its log: ${check.url}`,
      "Reproduce it in your worktree, fix it, commit, and request review again.",
    ].join("\n"),
  }));

/** One repo as the evidence and the artifact record it. */
export interface CiRepoFacts extends CiRepoRead {
  readonly pr_url: string;
}

export interface CiEvidenceFacts {
  /** The project's required entries, as stored. */
  readonly required: readonly string[];
  readonly repos: readonly CiRepoFacts[];
  readonly failed: boolean;
  readonly startedAt: number;
  readonly now: number;
  /** The artifact holding every check: `<gate artifacts>/ci-checks.json`. */
  readonly artifactPath: string;
}

/**
 * Each repo's group, its checks kept in order while the row's budget lasts — `CI_EVIDENCE_CHECKS_MAX`
 * between them — with each repo's true total beside them.
 */
function repoGroups(repos: readonly CiRepoFacts[]): CiRepoEvidence[] {
  return repos.reduce<{ kept: number; groups: CiRepoEvidence[] }>(
    (acc, r) => {
      const checks = r.checks.slice(
        0,
        Math.max(0, CI_EVIDENCE_CHECKS_MAX - acc.kept),
      );
      return {
        kept: acc.kept + checks.length,
        groups: [
          ...acc.groups,
          {
            repo_id: r.repo_id,
            sha: r.sha,
            pr_url: r.pr_url,
            checks: checks.map((c) => ({ ...c })),
            total: r.checks.length,
          },
        ],
      };
    },
    { kept: 0, groups: [] },
  ).groups;
}

/** §10.3's five facts and what was read, repo by repo, as a `ci` gate's evidence. */
export const ciEvidence = (f: CiEvidenceFacts): CiGateEvidence => ({
  command: ciCommand(f.required),
  exit_code: f.failed ? 1 : 0,
  duration_ms: Math.max(0, f.now - f.startedAt),
  cost_usd: 0,
  artifact_paths: [f.artifactPath],
  ci: { repos: repoGroups(f.repos), required: [...f.required] },
});
