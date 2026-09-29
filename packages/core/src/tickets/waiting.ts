import { GateFailReason } from "../gates/schemas.js";
import { FAILURE_CLASS } from "../laws/machine.js";
import type { TicketStatus } from "../laws/statuses.js";
import { MERGE_STATUSES } from "../laws/table.js";
import { HAPPENED, SAY, cap } from "./next-step-text.js";

// Whether a board card waits on the operator, from facts one set-based SQL pass reads for
// a whole page: nextStep needs the law facts of each ticket, which per card would be N+1. Same order
// and sentences as nextStep, so the card's "waiting on you" is nextStep's `you` or `paused`
// (`waitsOnYou`); next-step.test.ts holds the two together on every row of nextStep's table.
//
// One approximation, and the ticket page is exact: a round's parity and lint gates are read as
// required whenever the round opened them. Only an operator flipping `gates.parity_check` or
// `gates.lint_check` mid-round makes the card and the page disagree.

/** A card's short reason's most characters: a chip's hover text and an Overview row. */
export const WAIT_REASON_MAX = 120;

/**
 * The current round of a ticket in a status a gate decides (plan_review, code_review, qa_harness),
 * over that status's gate kinds, as the flag reads it.
 */
export interface ReviewWaitFacts {
  /** A gate of the status's kinds is running. */
  readonly running: boolean;
  /** Review gates are running and none has its reviewer session live yet. */
  readonly reviewerAwaited: boolean;
  /** The status's own gate (plan_review, code_review, qa_harness) is in the current round. */
  readonly anchored: boolean;
  /** Every latest attempt the round requires is passed or waived. */
  readonly settled: boolean;
  /** A latest attempt failed on blocking findings, a blocking finding still open. */
  readonly codeFailed: boolean;
  /** The most urgent latest failure's reason: infra, then base_drift, then code or subject. */
  readonly failure: string | null;
}

export interface WaitFacts {
  readonly status: TicketStatus;
  readonly needs_human: boolean;
  readonly blocked_reason: string | null;
  readonly open_questions: number;
  readonly proposal_open: boolean;
  /** The live holder session's state; null when none holds it. */
  readonly holder_state: string | null;
  readonly handoff_pending: boolean;
  readonly has_orchestrator: boolean;
  readonly fleet_paused: boolean;
  readonly project_paused: boolean;
  /** Every child is closed and the ticket holds no active worktree: close_split's laws. */
  readonly split_closable: boolean;
  readonly review: ReviewWaitFacts;
  readonly qa_configured: boolean;
  /**
   * What its pull requests say, in a project that closes on merge: `merged` (all of
   * them — foreman closes it), `awaiting` (all still open), `none` otherwise. Core's
   * `unmergedReason` and `awaitingMerge`, read by the board's SQL.
   */
  readonly merge: MergeWait;
}

export type MergeWait = "none" | "awaiting" | "merged";

/** Why a card waits on the operator. */
export const WaitCode = [
  "questions",
  "proposal",
  "blocked",
  "split",
  "released",
  "flag",
  "session",
  "no_orchestrator",
  "paused",
  "gate",
  "qa_note",
  "qa_human",
  "merge",
] as const;
export type WaitCode = (typeof WaitCode)[number];

export interface Wait {
  readonly code: WaitCode;
  readonly reason: string;
}

const wait = (code: WaitCode, reason: string): Wait => ({
  code,
  reason: cap(reason, WAIT_REASON_MAX),
});

/** The statuses a merged pull request closes a ticket from (core's MERGE_STATUSES). */
const MERGING: ReadonlySet<string> = new Set(MERGE_STATUSES);

/** The holder states that wait on the operator (nextStep's HOLDING). */
const ASKING = new Set(["awaiting_approval", "human_attached"]);

const pausedWait = (f: WaitFacts): Wait | null =>
  f.fleet_paused
    ? wait("paused", SAY.paused("fleet"))
    : f.project_paused
      ? wait("paused", SAY.paused("project"))
      : null;

const staffingWait = (f: WaitFacts): Wait | null =>
  f.has_orchestrator
    ? pausedWait(f)
    : wait(
        "no_orchestrator",
        SAY.staffYourself(f.handoff_pending ? "a successor" : "it"),
      );

function holderWait(f: WaitFacts): Wait | null {
  if (f.holder_state === null) return staffingWait(f);
  return ASKING.has(f.holder_state)
    ? wait("session", "Its session waits on you")
    : null;
}

type GateStatus = "plan_review" | "code_review" | "qa_harness";

const REVIEW_NAME: Readonly<Record<GateStatus, string>> = {
  plan_review: "Plan review",
  code_review: "Review",
  qa_harness: "QA",
};

/** nextStep's `review`, over the round's summary. */
function reviewWait(f: WaitFacts, status: GateStatus): Wait | null {
  const r = f.review;
  if (r.running) return r.reviewerAwaited ? pausedWait(f) : null;
  const name = REVIEW_NAME[status];
  const pass = r.anchored && r.settled;
  // A plan has no machine edge back (revise_plan is the orchestrator's); a review and QA do.
  const back = status !== "plan_review" && r.codeFailed;
  // Exactly one machine step applies: foreman takes it (both is the operator's call, as below).
  if (pass !== back) return null;
  const reason = GateFailReason.safeParse(r.failure);
  if (reason.success && FAILURE_CLASS[reason.data] === "infra") {
    return wait("gate", `${name} ${HAPPENED[reason.data]}`);
  }
  if (r.failure === "base_drift")
    return wait("gate", `${name} ${HAPPENED.base_drift}`);
  const redo =
    r.failure === "blocking_findings" || r.failure === "source_changes";
  if (status === "plan_review" && redo) return staffingWait(f);
  return wait("gate", SAY.notMoving(name));
}

type WorkStatus = Exclude<
  TicketStatus,
  "done" | "rejected" | "blocked" | "parked" | "split" | "handoff_pending"
>;

/** nextStep's `merging`: all merged waits on nobody; all open waits on the merge. */
const mergeWait = (): Wait => wait("merge", SAY.awaitingMerge([]));

function workingWait(f: WaitFacts, status: WorkStatus): Wait | null {
  if (f.merge === "merged" && MERGING.has(status)) return null;
  if (f.merge === "awaiting") {
    if (status === "qa_human") return mergeWait();
    if (status === "qa_harness" && !f.review.running) return mergeWait();
    if (status === "rework" && f.holder_state === null) return mergeWait();
  }
  switch (status) {
    case "backlog":
      return f.has_orchestrator
        ? pausedWait(f)
        : wait("no_orchestrator", SAY.prioritiseYourself);
    case "plan_review":
    case "code_review":
      return reviewWait(f, status);
    case "qa_harness":
      // M7.5 wires the QA gate; until then nothing configures one, and the operator's note passes.
      return f.qa_configured
        ? reviewWait(f, status)
        : wait("qa_note", SAY.qaNote);
    case "qa_human":
      return wait("qa_human", SAY.humanQa);
    default:
      return holderWait(f);
  }
}

/** Why the card waits on the operator, or null when it does not. */
export function waitingOnYou(f: WaitFacts): Wait | null {
  const { status } = f;
  if (status === "done" || status === "rejected") return null;
  if (f.open_questions > 0)
    return wait("questions", SAY.answers(f.open_questions));
  if (f.proposal_open) return wait("proposal", SAY.proposal);
  switch (status) {
    case "blocked":
      return wait("blocked", SAY.blocked(f.blocked_reason));
    case "parked":
      return null;
    case "split":
      return f.split_closable ? wait("split", SAY.splitClosable) : null;
    case "handoff_pending":
      return f.handoff_pending
        ? staffingWait(f)
        : wait("released", SAY.released);
    default:
      return f.needs_human ? wait("flag", SAY.flagged) : workingWait(f, status);
  }
}
