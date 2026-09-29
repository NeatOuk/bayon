import { ROUND_KINDS } from "../laws/table.js";
import type { ReviewFinding } from "./findings.js";
import { GateEvidence, GateFailure } from "./schemas.js";

// a review-round gate that failed because its base moved is answered by a fix round
// (core's `sentBackToFix`, which does not need this finding), and the fixer needs to be told what to
// do. decideGate files this one system finding with the decision, from the evidence it stores.
// It is informational: `minor`, below any sensible `gates.blocking_severities`, so a fixer that
// never resolves it cannot hold the next round's `pass_review` (an open blocker on any attempt
// would). Its summary alone is enough to act on, since ticket_get shows the summary and not the
// detail. Pure over the evidence and the repo's name.

/** `findings.category` of the system finding a drifted gate carries. */
export const DRIFT_CATEGORY = "base_drift";

/** Informational: the machine sends the round back on the drift itself, never on this finding. */
export const DRIFT_SEVERITY = "minor";

/** Before the summary when the gate is one repo's: the repo's name as the database has it. */
export const DRIFT_REPO_PREFIX = "Repo ";

/** A sha as a summary shows it: enough to find the commit, short enough to read. */
const SHORT = 12;

/** The tip the base moved to, when the evidence recorded it (a drift found at pin). */
function tipOf(evidence: unknown): string | null {
  const failure = GateFailure.safeParse(evidence);
  return failure.success && failure.data.drift !== undefined
    ? failure.data.drift.tip_sha
    : null;
}

/** What the evidence says moved: at pin, the pinned base and the tip; after a review, the base. */
function whatMoved(evidence: unknown): string {
  const failure = GateFailure.safeParse(evidence);
  if (failure.success && failure.data.drift !== undefined) {
    const { base_sha, tip_sha } = failure.data.drift;
    return `The review round pinned base \`${base_sha}\`, but the base branch is now at \`${tip_sha}\`.`;
  }
  const reviewed = GateEvidence.safeParse(evidence);
  if (reviewed.success) {
    return `The base branch has moved since this review pinned \`${reviewed.data.subject.base_sha}\`.`;
  }
  return "The base branch moved after this branch was built.";
}

function steps(tip: string | null): string {
  return [
    "Bring the branch up to date before you resubmit:",
    "",
    "1. `git fetch origin <base>`, where `<base>` is the branch this one was cut from (usually the repository's default)",
    tip === null
      ? "2. `git merge FETCH_HEAD`, resolving any conflicts"
      : `2. \`git merge ${tip}\`, resolving any conflicts`,
    "3. rerun the repository's install, build, lint and test commands, and commit",
    "4. resolve this finding (`finding_resolve`), then resubmit: the next review round pins the new tip.",
  ].join("\n");
}

/**
 * The finding a gate of `kind` that failed `base_drift` carries: what moved and how to catch up,
 * prefixed with the repo's name for a per-repo gate. Null for a kind no fix round answers
 * (plan_review, qa_harness).
 */
export function driftFinding(
  kind: string,
  evidence: unknown,
  repoName: string | null = null,
): ReviewFinding | null {
  if (!(ROUND_KINDS as readonly string[]).includes(kind)) return null;
  const tip = tipOf(evidence);
  const target = tip === null ? "its tip" : tip.slice(0, SHORT);
  const prefix = repoName === null ? "" : `${DRIFT_REPO_PREFIX}${repoName}: `;
  return {
    severity: DRIFT_SEVERITY,
    summary: `${prefix}The base branch moved: merge ${target} into this branch, rerun the checks, then resubmit`,
    file: null,
    line: null,
    category: DRIFT_CATEGORY,
    detail_md: `${whatMoved(evidence)} A review of a branch behind its base reads a diff against a base it will not merge into.\n\n${steps(tip)}`,
  };
}
