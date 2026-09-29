import { StoredGateEvidence, type GateFailReason } from "../gates/schemas.js";
import { unmergedReason } from "./merge.js";
import { owedRepos } from "./requirements.js";
import { currentRound, gateWhenHolds } from "./rounds.js";
import type { GateKind, TicketStatus } from "./statuses.js";
import { EDGES, MERGE_STATUSES, ROUND_KINDS } from "./table.js";
import type { GateFact, GateFacts, LawTicket, MergeFacts } from "./types.js";

// Machine steps: the edges a gate's decision settles on its own, so the supervisor
// takes them in the decision's own transaction (advanceTicket) instead of leaving the ticket for
// someone to notice. Pure over the facts the laws read. This says which edge applies; core's
// `decide` still judges the move, and a refusal writes nothing.

/** The edges the supervisor takes after a gate decides, beside the circuit breaker's `block`. */
export const GATE_RULES = [
  "approve_plan",
  "pass_review",
  "request_fix",
  "pass_harness",
  "fail_harness",
] as const;

/**
 * Every edge the supervisor takes through advanceTicket: the gate-decided five, and `merge_close`
 *, which a merged pull request settles and the pull-request sweep takes in the same
 * transaction as it records the merge.
 */
export const MACHINE_RULES = [...GATE_RULES, "merge_close"] as const;
export type MachineRule = (typeof MACHINE_RULES)[number];

/**
 * The statuses a gate-decided step leaves from, read off the table: what the reconciler's machine
 * sweep looks at (plan_review, code_review, qa_harness). `merge_close`'s are the pull-request
 * sweep's, which knows which tickets have a merge to act on.
 */
export const MACHINE_STATUSES: readonly TicketStatus[] = [
  ...new Set(
    EDGES.flatMap((e) =>
      e.from !== "*" && (GATE_RULES as readonly string[]).includes(e.rule)
        ? [e.from]
        : [],
    ),
  ),
];

/**
 * What a failed gate's reason says about the change. `code`: a reviewer read it and left blocking
 * findings. `infra`: nothing judged the code (no reviewer, a reviewer that broke, a timeout, a
 * restart, evidence that failed its schema). `stale`: the change is behind its base (the base moved
 * after the branch was built), answered by a fix round that brings the branch up to date and
 * resubmits. `subject`: what was reviewed is wrong for the review (a plan changed source
 * files), answered by `revise_plan`, not a fix round. `superseded`: not a verdict at all.
 */
export type FailureClass =
  "code" | "infra" | "stale" | "subject" | "superseded";

/** Every reason classified: a reason added to GateFailReason does not compile until it is here. */
export const FAILURE_CLASS: Readonly<Record<GateFailReason, FailureClass>> = {
  blocking_findings: "code",
  timeout: "infra",
  supervisor_restart: "infra",
  no_reviewer: "infra",
  reviewer_error: "infra",
  missing_evidence: "infra",
  base_drift: "stale",
  source_changes: "subject",
  superseded: "superseded",
};

/** The reason a decided gate's evidence records (either shape), or null when none parses. */
export function failReason(evidence: unknown): GateFailReason | null {
  const parsed = StoredGateEvidence.safeParse(evidence);
  return parsed.success ? (parsed.data.reason ?? null) : null;
}

/**
 * The gate failed because the code has blocking findings, and for no other reason. Evidence that
 * does not parse has no reason, so it is not a code failure: nothing defaults to blaming the code.
 */
export const isCodeFailure = (
  gate: Pick<GateFact, "state" | "evidence">,
): boolean => {
  if (gate.state !== "failed") return false;
  const reason = failReason(gate.evidence);
  return reason !== null && FAILURE_CLASS[reason] === "code";
};

/** What machineStep reads: the ticket, its gate facts and its merge facts, as the laws read them. */
export interface MachineInput {
  readonly ticket: LawTicket;
  readonly gates: GateFacts;
  readonly merge: MergeFacts;
}

export type MachineStep =
  | {
      readonly take: true;
      readonly rule: MachineRule;
      readonly to: TicketStatus;
    }
  | { readonly take: false; readonly why: string };

const wait = (why: string): MachineStep => ({ take: false, why });

const TARGET: Readonly<Record<MachineRule, TicketStatus>> = {
  approve_plan: "planned",
  pass_review: "qa_harness",
  request_fix: "review_fix",
  pass_harness: "qa_human",
  fail_harness: "rework",
  merge_close: "done",
};

/**
 * The kinds whose code failure is a fix round's: every kind a review round opens. A lint or parity
 * job that failed on `blocking_findings` found something wrong with the change, the same as a
 * reviewer; one that failed for any other reason did not, and never starts a fix round.
 */
const FIX_KINDS: readonly GateKind[] = ROUND_KINDS;
const PLAN_KINDS: readonly GateKind[] = ["plan_review"];
const QA_KINDS: readonly GateKind[] = ["qa_harness"];

/** Passed, or waived (whose reason `decide` still checks). */
const settled = (g: GateFact): boolean =>
  g.state === "passed" || g.state === "waived";

const hasOpenBlocker = (
  g: Pick<GateFact, "openSeverities">,
  blocking: readonly string[],
): boolean => g.openSeverities.some((s) => blocking.includes(s));

/** The highest attempt of each (kind, repo) among `gates`. */
const latestEach = (gates: readonly GateFact[]): readonly GateFact[] =>
  gates.filter(
    (g) =>
      !gates.some(
        (o) =>
          o.kind === g.kind && o.repoId === g.repoId && o.attempt > g.attempt,
      ),
  );

export interface RoundView {
  /** Gates of the kinds still running, in any round. */
  readonly running: readonly GateFact[];
  /** The latest attempt of each (kind, repo) of the kinds in the ticket's current round. */
  readonly latest: readonly GateFact[];
}

/**
 * The ticket's current round (the laws' own number, 023), narrowed to `kinds`. Exported for core's
 * nextStep, which says why a ticket waits from the same view the machine steps read.
 */
export function roundOf(
  gates: GateFacts,
  kinds: readonly GateKind[],
): RoundView {
  const round = currentRound(gates.gates);
  const ofKinds = gates.gates.filter((g) =>
    (kinds as readonly string[]).includes(g.kind),
  );
  return {
    running: ofKinds.filter((g) => g.state === "running"),
    latest: latestEach(ofKinds.filter((g) => g.round === round)),
  };
}

/**
 * Every repo that owes a gate of each of `kinds` has one in the round, and its latest attempt is
 * settled. Which repos owe one is the laws' own list (`owedRepos`, the loop `gatePassed` runs), so a
 * per-repo kind is complete only when each of its repos is — never when some gate of it exists.
 * `latest` holds one gate per (kind, repo), the highest attempt, so "some settled" is "the latest
 * is settled".
 */
const allSettled = (
  latest: readonly GateFact[],
  kinds: readonly GateKind[],
  facts: GateFacts,
): boolean =>
  kinds.every((kind) =>
    owedRepos(kind, facts).every((repo) =>
      latest.some((g) => g.kind === kind && g.repoId === repo && settled(g)),
    ),
  );

/**
 * A gate a fix round answers: it failed on the code with a blocking finding still open, or — a
 * review-round kind only — its base moved, whatever findings it carries. A drifted gate
 * needs no finding to be sent back, so a ticket stranded before its decision filed one moves too;
 * the finding is the fixer's instruction, not the machine's reason.
 */
export const sentBackToFix = (
  g: Pick<GateFact, "kind" | "state" | "evidence" | "openSeverities">,
  blocking: readonly string[],
  /**
   * The kinds whose drift counts: the ones the round still requires, so a drifted gate of a kind
   * no longer owed (ce_review on a ticket since marked trivial) cannot make `request_fix` apply
   * beside `pass_review`. Every review-round kind when not given.
   */
  driftKinds: readonly string[] = FIX_KINDS,
): boolean => {
  if (g.state !== "failed") return false;
  const reason = failReason(g.evidence);
  if (reason === null) return false;
  if (FAILURE_CLASS[reason] === "stale") {
    return (
      (FIX_KINDS as readonly string[]).includes(g.kind) &&
      driftKinds.includes(g.kind)
    );
  }
  return FAILURE_CLASS[reason] === "code" && hasOpenBlocker(g, blocking);
};

/** A latest gate of `kinds` is one a fix round answers (`sentBackToFix`). */
const failedToFix = (
  latest: readonly GateFact[],
  kinds: readonly GateKind[],
  blocking: readonly string[],
  driftKinds?: readonly string[],
): boolean =>
  latest.some(
    (g) =>
      (kinds as readonly string[]).includes(g.kind) &&
      sentBackToFix(g, blocking, driftKinds),
  );

/**
 * The gates `rule` requires for this ticket, from its own row of the table (`gate_passed` with a
 * `when` that holds), so the table stays the one list of what a round owes.
 */
function requiredGates(rule: MachineRule, i: MachineInput): GateKind[] {
  const facts = {
    non_trivial: i.ticket.non_trivial,
    multiRepo: i.gates.multiRepo,
    lintRepos: i.gates.lintRepos,
    qaConfigured: i.gates.qaConfigured,
  };
  return EDGES.filter((e) => e.rule === rule)
    .flatMap((e) => e.requires)
    .flatMap((r) =>
      r.kind === "gate_passed" && gateWhenHolds(r.when, facts) ? [r.gate] : [],
    );
}

/** Exactly one applicable edge is taken; none, or more than one, waits. */
function one(rules: readonly MachineRule[], none: string): MachineStep {
  const [rule, ...rest] = rules;
  if (rule === undefined) return wait(none);
  if (rest.length > 0) {
    return wait(
      `${[rule, ...rest].join(" and ")} both apply; the operator decides`,
    );
  }
  return { take: true, rule, to: TARGET[rule] };
}

const kindsOf = (gates: readonly GateFact[]): string =>
  [...new Set(gates.map((g) => g.kind))].join(", ");

function planStep(i: MachineInput): MachineStep {
  const { running, latest } = roundOf(i.gates, PLAN_KINDS);
  if (running.length > 0) return wait("plan_review is still running");
  return one(
    allSettled(latest, PLAN_KINDS, i.gates) ? ["approve_plan"] : [],
    "the round's plan_review has not passed",
  );
}

/** A gate of a review-round kind that failed because its base moved. */
const driftedGate = (
  g: Pick<GateFact, "kind" | "state" | "evidence">,
): boolean =>
  (FIX_KINDS as readonly string[]).includes(g.kind) &&
  g.state === "failed" &&
  failReason(g.evidence) === "base_drift";

/**
 * How many review rounds running, up to the current one, had a gate fail because the base moved
 *: the current round less the latest round with none. The board's SQL
 * (`ticket-waits.ts`) counts it the same way.
 */
export function driftStreak(gates: readonly GateFact[]): number {
  const drifted = new Set(gates.filter(driftedGate).map((g) => g.round));
  const clean = gates.map((g) => g.round).filter((r) => !drifted.has(r));
  return currentRound(gates) - Math.max(0, ...clean);
}

/** The drift cap (`gates.drift_rounds_max`): reached, the operator decides, not a fix round. */
export const driftCapped = (gates: GateFacts): boolean =>
  driftStreak(gates.gates) >= gates.driftRoundsMax;

function reviewStep(i: MachineInput): MachineStep {
  const { running, latest } = roundOf(i.gates, ROUND_KINDS);
  if (running.length > 0) return wait(`${kindsOf(running)} still running`);
  if (driftCapped(i.gates)) {
    return wait(
      `the base moved in ${driftStreak(i.gates.gates)} rounds running; the operator decides`,
    );
  }
  const required = requiredGates("pass_review", i);
  const rules: MachineRule[] = [
    ...(allSettled(latest, required, i.gates)
      ? (["pass_review"] as const)
      : []),
    ...(failedToFix(latest, FIX_KINDS, i.gates.blockingSeverities, required)
      ? (["request_fix"] as const)
      : []),
  ];
  return one(
    rules,
    "the round neither passed nor failed on blocking findings or a moved base (any other failure is not the code's)",
  );
}

/**
 * The QA hook (M7.5 wires the gate): the harness verdict from the latest `qa_harness` gates of the
 * round, none of them running. Every repo that owes one settled passes; one failed on blocking
 * findings fails; anything else (an infra failure, a repo with no gate) is null. The QA gate calls
 * this; machineStep does too.
 */
export function harnessRule(
  latest: readonly GateFact[],
  facts: GateFacts,
): "pass_harness" | "fail_harness" | null {
  if (latest.some((g) => g.state === "running")) return null;
  if (allSettled(latest, QA_KINDS, facts)) return "pass_harness";
  return failedToFix(latest, QA_KINDS, facts.blockingSeverities)
    ? "fail_harness"
    : null;
}

function harnessStep(i: MachineInput): MachineStep {
  const { running, latest } = roundOf(i.gates, QA_KINDS);
  if (running.length > 0) return wait("qa_harness is still running");
  const rule = harnessRule(latest, i.gates);
  return one(
    rule === null ? [] : [rule],
    "no QA verdict in the round (none yet, or a failure that is not the code's)",
  );
}

const isMergeStatus = (status: TicketStatus): boolean =>
  (MERGE_STATUSES as readonly string[]).includes(status);

/**
 * `merge_close` when every pull request of the ticket merged in a project that closes on merge
 *, else why not. At `qa_harness` it is asked before the harness: a merge supersedes a
 * harness still running, because the change it checks has already shipped.
 */
function mergeStep(i: MachineInput): MachineStep {
  const why = unmergedReason(i.merge);
  return why === null
    ? { take: true, rule: "merge_close", to: TARGET.merge_close }
    : wait(why);
}

/**
 * The one machine edge the ticket's stored facts now settle, or why none does. A status a gate
 * decides has one (plan_review, code_review, qa_harness), and so does one a merge closes
 * (qa_harness, qa_human, rework).
 */
export function machineStep(i: MachineInput): MachineStep {
  if (isMergeStatus(i.ticket.status)) {
    const merged = mergeStep(i);
    if (merged.take || i.ticket.status !== "qa_harness") return merged;
  }
  switch (i.ticket.status) {
    case "plan_review":
      return planStep(i);
    case "code_review":
      return reviewStep(i);
    case "qa_harness":
      return harnessStep(i);
    default:
      return wait(`${i.ticket.status} is not a status a gate decides`);
  }
}
