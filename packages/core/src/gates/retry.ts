import {
  nextAttempt,
  subjectOf,
  type RoundGate,
  type RoundGateFact,
  type RoundTicket,
} from "../laws/rounds.js";
import { CI_SUBJECT } from "./ci.js";
import { GATE_REVIEW_STATUS, isRoundGateKind } from "./roles.js";
import type { GateFailReason } from "./schemas.js";

// decideGate's retry: a gate that timed out or met a supervisor restart opens
// its next attempt in the same transaction, for the same kind and repo, at most
// gates.timeout_retries times in a row. Pure over the rows the writer reads.

/** The reasons a gate is retried for: the reviewer never had its say. */
export const RETRY_REASONS: readonly GateFailReason[] = [
  "timeout",
  "supervisor_restart",
];

/** A gate row with the reason its decision recorded (null while running, or when passed). */
export interface RetryGateFact extends RoundGateFact {
  readonly reason: string | null;
  /** `gates.subject_kind`: a CI gate (`CI_SUBJECT`) is never retried. */
  readonly subject_kind?: string;
}

export interface RetryInput {
  /** The gate being decided, with the reason its verdict failed it for. */
  readonly decided: RetryGateFact;
  /** Every gate of the ticket, `decided` included as it stands before the decision. */
  readonly gates: readonly RetryGateFact[];
  readonly ticket: RoundTicket & { readonly status: string };
  /** gates.timeout_retries. */
  readonly retries: number;
}

/**
 * The consecutive attempts of `decided`'s kind and repo just before it that failed with a retry
 * reason: the retries already spent on this review.
 */
export function retriesUsed(i: RetryInput): number {
  const earlier = i.gates
    .filter(
      (g) =>
        g.kind === i.decided.kind &&
        g.repo_id === i.decided.repo_id &&
        g.attempt < i.decided.attempt,
    )
    .toSorted((a, b) => b.attempt - a.attempt);
  const streak = earlier.findIndex(
    (g) => g.reason === null || !isRetryReason(g.reason),
  );
  return streak === -1 ? earlier.length : streak;
}

const isRetryReason = (reason: string): boolean =>
  RETRY_REASONS.some((r) => r === reason);

/** The next attempt to open, or null: no retry reason, the ticket moved on, another runs, or spent. */
export function planRetry(i: RetryInput): RoundGate | null {
  const { decided } = i;
  if (decided.reason === null || !isRetryReason(decided.reason)) return null;
  // Every kind a review round opens, `parity_check` included: a script job that met a restart is
  // no less worth re-running than a reviewer that did.
  if (!isRoundGateKind(decided.kind)) return null;
  // A CI gate's timeout is CI's own clock running out, not a reviewer interrupted: a retry would
  // wait the whole deadline again for the answer that did not come.
  if (decided.subject_kind === CI_SUBJECT) return null;
  if (i.ticket.status !== GATE_REVIEW_STATUS[decided.kind]) return null;
  const otherRunning = i.gates.some(
    (g) =>
      g.id !== decided.id && g.kind === decided.kind && g.state === "running",
  );
  if (otherRunning) return null;
  if (retriesUsed(i) >= i.retries) return null;
  return {
    kind: decided.kind,
    repo_id: decided.repo_id,
    attempt: nextAttempt(decided.kind, i.gates),
    // The retry belongs to the round of the gate it follows (023): the reviewer never
    // had its say, so this is the same review asked again and not a new round of them.
    round: decided.round,
    ...subjectOf(decided.kind, i.ticket),
  };
}
