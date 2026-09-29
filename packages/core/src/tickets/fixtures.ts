import { expect, test } from "vitest";
import { isReviewGateKind } from "../gates/roles.js";
import { GateFailReason } from "../gates/schemas.js";
import { allowedTransitions } from "../laws/allowed.js";
import {
  EVIDENCE,
  OPERATOR,
  gate,
  knownGates,
  lawFacts,
  lawTicket,
} from "../laws/fixtures.js";
import {
  FAILURE_CLASS,
  failReason,
  driftCapped,
  sentBackToFix,
  roundOf,
} from "../laws/machine.js";
import {
  TICKET_STATUSES,
  type GateKind,
  type TicketStatus,
} from "../laws/statuses.js";
import { awaitingMerge, unmergedReason } from "../laws/merge.js";
import { ROUND_KINDS } from "../laws/table.js";
import type { GateFact, GateFacts, Known, LawFacts } from "../laws/types.js";
import {
  NO_CI_WAIT,
  NextStep,
  nextStep,
  waitsOnYou,
  type NextStepFacts,
  type NextStepHolder,
  type NextStepTicket,
} from "./next-step.js";
import { REASON_MAX } from "./next-step-text.js";
import { WAIT_REASON_MAX, waitingOnYou, type WaitFacts } from "./waiting.js";

// Builders for the nextStep and waitingOnYou tests. Test support only: excluded from
// coverage (vitest.config.ts). A row's transitions are the laws' own (allowedTransitions for the
// operator, as GET /tickets/:ref computes them), so a row's action is one the Actions panel shows.
// `waitFactsOf` is the board's facts as its SQL reads them (ticket-waits.ts), taken from a row.

export interface Build {
  readonly status: TicketStatus;
  readonly ticket?: Partial<NextStepTicket>;
  /** Law facts the transitions are judged on (children, worktrees, prior status). */
  readonly law?: Partial<LawFacts>;
  readonly gates?: readonly GateFact[];
  /** Instead of `gates`: gate facts as given (unavailable ones). */
  readonly gateFacts?: Known<GateFacts>;
  readonly facts?: Partial<Omit<NextStepFacts, "ticket" | "gates">>;
}

export function build(b: Build): NextStepFacts {
  const ticket: NextStepTicket = {
    ...lawTicket(b.status),
    needs_human: false,
    blocked_reason: null,
    unblock_condition: null,
    ...b.ticket,
  };
  const gates = b.gateFacts ?? knownGates(b.gates ?? []);
  const law = lawFacts({
    actorSession: null,
    ticketSessions: [],
    worktrees: [],
    gates,
    ...b.law,
  });
  return {
    ticket,
    openQuestions: 0,
    proposalOpen: false,
    gates,
    liveGateIds: [],
    holder: null,
    handoffPending: false,
    transitions: allowedTransitions({ ticket, actor: OPERATOR, facts: law }),
    parkNote: null,
    pause: { fleet: false, project: false },
    hasOrchestrator: true,
    qaConfigured: false,
    ci: NO_CI_WAIT,
    merge: law.merge,
    ...b.facts,
  };
}

export const holder = (
  state: NextStepHolder["state"],
  turns = 14,
): NextStepHolder => ({ agent: "agent-7", state, turns });

export const failed = (
  kind: string,
  reason: GateFailReason,
  o: Partial<GateFact> = {},
): GateFact => gate({ kind, state: "failed", evidence: { reason }, ...o });
export const running = (kind: string, o: Partial<GateFact> = {}): GateFact =>
  gate({ kind, state: "running", evidence: null, ...o });
export const onCode = (kind: string, o: Partial<GateFact> = {}): GateFact =>
  gate({
    kind,
    state: "failed",
    evidence: { ...EVIDENCE, reason: "blocking_findings" },
    openSeverities: ["major"],
    ...o,
  });

export const FLEET = { fleet: true, project: false };
export const PROJECT = { fleet: false, project: true };
export const move = (label: string, target: TicketStatus) =>
  ({ kind: "transition", label, target }) as const;
export const RESUME_FLEET = {
  kind: "unpause",
  label: "Resume the fleet",
  target: "fleet",
} as const;
export const RESUME_PROJECT = {
  kind: "unpause",
  label: "Resume the project",
  target: "project",
} as const;
export const STAFF_HINT = {
  kind: "none",
  label: "Staff it from the Actions panel",
} as const;
export const FLEET_PAUSED = "Fleet is paused. Next: ";

export interface Row {
  readonly name: string;
  readonly facts: NextStepFacts;
  readonly want: NextStep;
}

export const row = (name: string, b: Build, want: NextStep): Row => ({
  name,
  facts: build(b),
  want,
});

export const NO_REVIEWER = failed("code_review", "no_reviewer", {
  id: "cr-nr",
  evidence: { reason: "no_reviewer", detail: "no certified runner is enabled" },
});
export const TIMED_OUT = failed("code_review", "timeout", { id: "cr-to" });
export const BROKE = gate({
  id: "cr-err",
  kind: "code_review",
  state: "failed",
  evidence: { ...EVIDENCE, reason: "reviewer_error" },
});
export const SUPERSEDED = failed("code_review", "superseded", { id: "cr-sup" });
export const UNREADABLE = gate({
  id: "cr-bad",
  kind: "code_review",
  state: "failed",
  evidence: null,
});

/** The board's facts, as its SQL reads them (ticket-waits.ts), taken from a row's facts. */
const KINDS: Partial<Record<TicketStatus, readonly GateKind[]>> = {
  plan_review: ["plan_review"],
  code_review: ROUND_KINDS,
  qa_harness: ["qa_harness"],
};

const URGENCY = (reason: string): number => {
  const parsed = GateFailReason.safeParse(reason);
  if (parsed.success && FAILURE_CLASS[parsed.data] === "infra") return 0;
  if (reason === "base_drift") return 1;
  return reason === "blocking_findings" || reason === "source_changes" ? 2 : 3;
};

export function waitFactsOf(f: NextStepFacts): WaitFacts | null {
  // The page alone reads the gate settings: an unreadable one is its to say.
  if (f.gates.state === "unavailable") return null;
  const g = f.gates.value;
  const kinds = KINDS[f.ticket.status] ?? [];
  const anchor = kinds.includes("code_review") ? "code_review" : kinds[0];
  const { running, latest } = roundOf(g, kinds);
  const reviews = running.filter((x) => isReviewGateKind(x.kind));
  const required = latest.filter(
    (x) => x.kind !== "ce_review" || f.ticket.non_trivial,
  );
  const ceOwed =
    f.ticket.status === "code_review" &&
    f.ticket.non_trivial &&
    !latest.some((x) => x.kind === "ce_review");
  const failures = latest
    .filter((x) => x.state === "failed")
    .map((x) => failReason(x.evidence))
    .flatMap((r) => (r === null ? [] : [r]))
    .toSorted((a, b) => URGENCY(a) - URGENCY(b));
  return {
    status: f.ticket.status,
    needs_human: f.ticket.needs_human,
    blocked_reason: f.ticket.blocked_reason,
    open_questions: f.openQuestions,
    proposal_open: f.proposalOpen,
    holder_state: f.holder?.state ?? null,
    handoff_pending: f.handoffPending,
    has_orchestrator: f.hasOrchestrator,
    fleet_paused: f.pause.fleet,
    project_paused: f.pause.project,
    split_closable: f.transitions.some(
      (t) => t.rule === "close_split" && t.allowed,
    ),
    review: {
      running: running.length > 0,
      reviewerAwaited:
        reviews.length > 0 &&
        !reviews.some((x) => f.liveGateIds.includes(x.id)),
      anchored: latest.some((x) => x.kind === anchor),
      settled:
        !ceOwed &&
        required.every((x) => x.state === "passed" || x.state === "waived"),
      codeFailed:
        !driftCapped(g) &&
        latest.some((x) =>
          sentBackToFix(
            x,
            g.blockingSeverities,
            kinds.filter((k) => k !== "ce_review" || f.ticket.non_trivial),
          ),
        ),
      failure: failures[0] ?? null,
    },
    qa_configured: f.qaConfigured,
    merge:
      unmergedReason(f.merge) === null
        ? "merged"
        : awaitingMerge(f.merge).length > 0
          ? "awaiting"
          : "none",
  };
}

/** The statuses a gate decides, whose rows are next-step-gates.test.ts's. */
export const GATE_STATUSES: readonly TicketStatus[] = [
  "plan_review",
  "code_review",
  "qa_harness",
  "qa_human",
];

/** Every other status: next-step.test.ts's rows. */
export const WORK_STATUSES: readonly TicketStatus[] = TICKET_STATUSES.filter(
  (s) => !GATE_STATUSES.includes(s),
);

/** Each row says what it waits on, as the table wants, and the board's flag agrees with it. */
export function checkRows(rows: readonly Row[]): void {
  test.each(rows.map((r) => [r.name, r] as const))("%s", (_name, r) => {
    const got = nextStep(r.facts);
    expect(got).toEqual(r.want);
    expect(NextStep.parse(got)).toEqual(got);
    expect(got.reason.length).toBeLessThanOrEqual(REASON_MAX);
    // The board's flag, from the facts its SQL reads: `you` or `paused` exactly when it is set.
    const facts = waitFactsOf(r.facts);
    if (facts === null) return;
    const flag = waitingOnYou(facts);
    expect(flag !== null).toBe(waitsOnYou(got));
    if (flag !== null)
      expect(flag.reason.length).toBeLessThanOrEqual(WAIT_REASON_MAX);
  });
}
