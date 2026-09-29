import {
  GateEvidence,
  GateFailReason,
  REVIEW_GATE_KINDS,
  RETRY_REASONS,
} from "@bayon/core";
import type { GateView } from "@bayon/proto";
import { gateStatus } from "@/components/status";

// The gate strip's and the review queue's pure half (§10.3, M3 contracts): how a gate's state and
// failure read, its reviewer and flags from the evidence, the automatic retry, and the strip's groups.

/** What a ticket's GateView and the queue's GateSummary both carry. */
export type GateFacts = Pick<
  GateView,
  "id" | "kind" | "state" | "attempt" | "repo_id" | "reason" | "evidence"
>;

/** A gate's kind, and its repo when the round touched more than one. */
export const gateName = (gate: Pick<GateFacts, "kind" | "repo_id">): string =>
  gate.repo_id === null ? gate.kind : `${gate.kind} · ${gate.repo_id}`;

/** A reason core knows, or null for none or one a newer server added (shown as stored). */
const knownReason = (reason: string | null): GateFailReason | null => {
  const parsed = GateFailReason.safeParse(reason);
  return parsed.success ? parsed.data : null;
};

/**
 * "failed (superseded)", "failed (reviewer error)": the gate's badge label (status.ts, one map for
 * both), lower-cased to run on inside a sentence — an earlier attempt's line, the live announcement.
 */
export const stateLabel = (
  gate: Pick<GateFacts, "state" | "reason">,
): string => {
  const label = gateStatus(gate).label;
  return label.charAt(0).toLowerCase() + label.slice(1);
};

const FAILURE_NOTES: Readonly<Record<GateFailReason, string>> = {
  timeout: "No terminal event inside the gate's wall clock.",
  supervisor_restart: "The supervisor restarted while the review ran.",
  no_reviewer: "No enabled, certified reviewer was available.",
  reviewer_error:
    "The reviewer failed: it exited non-zero or its findings did not parse. Not a finding.",
  missing_evidence: "The evidence was incomplete: no evidence, no pass.",
  source_changes: "The plan review's subject changed source files.",
  base_drift: "The base moved under the review.",
  blocking_findings: "Open findings at a blocking severity.",
  superseded: "The ticket moved on while the review ran.",
};

/** Why a failed gate failed, when core knows the reason. */
export const failureNote = (
  gate: Pick<GateFacts, "state" | "reason">,
): string | null => {
  const reason = gate.state === "failed" ? knownReason(gate.reason) : null;
  return reason === null ? null : FAILURE_NOTES[reason];
};

/**
 * Why a gate that failed before a review did: the detail line its evidence carries (the
 * runners a no_reviewer considered, a base_drift's base and tip). Null for full evidence or none.
 */
export function failureDetail(
  gate: Pick<GateFacts, "state" | "evidence">,
): string | null {
  const e = gate.evidence;
  if (gate.state !== "failed" || typeof e !== "object" || e === null)
    return null;
  return "detail" in e && typeof e.detail === "string" && e.detail !== ""
    ? e.detail
    : null;
}

export interface Reviewer {
  readonly runner: string;
  readonly flags: readonly string[];
}

/** The reviewer and its flags, from full evidence; null before there is any (running, or no process). */
export function reviewerOf(evidence: unknown): Reviewer | null {
  const parsed = GateEvidence.safeParse(evidence);
  if (!parsed.success) return null;
  const { runner_id, flags } = parsed.data;
  return {
    runner: runner_id,
    flags: [
      ...(flags.single_runner_review === true ? ["single-runner review"] : []),
      ...(flags.fallback_from === undefined
        ? []
        : [`fallback from ${flags.fallback_from}`]),
      ...(flags.base_drift === true ? ["base drift"] : []),
    ],
  };
}

/**
 * The attempt `gate` retries when decideGate opened it itself: the one before it, of its kind and
 * repo, failed for a retry reason (a timeout or a supervisor restart).
 */
export function retriedAttempt<G extends GateFacts>(
  gate: GateFacts,
  gates: readonly G[],
): G | null {
  const before = gates.find(
    (g) =>
      g.kind === gate.kind &&
      g.repo_id === gate.repo_id &&
      g.attempt === gate.attempt - 1,
  );
  if (before?.state !== "failed") return null;
  const reason = knownReason(before.reason);
  return reason !== null && RETRY_REASONS.includes(reason) ? before : null;
}

export interface GateGroup<G extends GateFacts> {
  readonly key: string;
  readonly latest: G;
  /** The earlier attempts, newest first: each counts as a round, so each shows why it failed. */
  readonly earlier: readonly G[];
}

const kindRank = (kind: string): number => {
  const rank = REVIEW_GATE_KINDS.findIndex((k) => k === kind);
  return rank === -1 ? REVIEW_GATE_KINDS.length : rank;
};

/** One group per kind and repo, in review order (plan, code, ce), its latest attempt first. */
export function gateGroups<G extends GateFacts>(
  gates: readonly G[],
): GateGroup<G>[] {
  const byKey = Map.groupBy(gates, (g) => `${g.kind}·${g.repo_id ?? ""}`);
  return [...byKey.entries()]
    .flatMap(([key, group]) => {
      const [latest, ...earlier] = group.toSorted(
        (a, b) => b.attempt - a.attempt,
      );
      return latest === undefined ? [] : [{ key, latest, earlier }];
    })
    .toSorted(
      (a, b) =>
        kindRank(a.latest.kind) - kindRank(b.latest.kind) ||
        a.key.localeCompare(b.key),
    );
}
