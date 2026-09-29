import { z } from "zod";

// §3.2's ticket statuses, the actors the laws know, the gate kinds of §10.3, and the closed set
// of reasons a law refuses with.

export const TICKET_STATUSES = [
  "backlog",
  "prioritized",
  "staffed",
  "spiking",
  "plan_review",
  "planned",
  "building",
  "code_review",
  "review_fix",
  "qa_harness",
  "qa_human",
  "rework",
  "done",
  "blocked",
  "parked",
  "rejected",
  "handoff_pending",
  "split",
] as const;
export const TicketStatus = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** No row leaves these: there is no reopen in M1. */
export const isTerminal = (status: TicketStatus): boolean =>
  status === "done" || status === "rejected";

/**
 * The operator (REST), an orchestrator session, or any other session (a worker). `supervisor` is the
 * daemon's, on seven edges only, each through its named writer: `block`, the circuit breaker's,
 * through blockTicket, the five machine steps a gate's decision settles,
 * through advanceTicket, and `merge_close`, a merged pull request's, through
 * advanceTicket too. No API door ever produces it.
 */
export const ActorKind = z.enum([
  "operator",
  "orchestrator",
  "worker",
  "supervisor",
]);
export type ActorKind = z.infer<typeof ActorKind>;

export const GateKind = z.enum([
  "plan_review",
  "code_review",
  "ce_review",
  "parity_check",
  "lint_check",
  "qa_harness",
  "human_qa",
]);
export type GateKind = z.infer<typeof GateKind>;

/**
 * Whether a round opens (and a law checks) one gate of `kind` per touched repo, or one for the
 * ticket. The reviews are per repo: each repo's change is reviewed on its own.
 *
 * Two kinds are not. Parity is a property of the *workspace* — whether its repos, worktrees and
 * submodule declarations agree — so it opens once, repo-less, however many repos the ticket
 * touches, and `pass_review` asks for that one gate (§3.1). `qa_harness` has the same
 * shape for a different reason: the command is the **project's**, one command for the
 * thing being delivered, so a per-repo QA gate would run it once per repo and report the same
 * answer as many times.
 *
 * `lint_check` is per repo like the reviews: the command it runs is that repo's
 * `repos.lint_cmd`, so two repos of one workspace are linted apart, not together.
 */
export const isPerRepoGate = (kind: GateKind): boolean =>
  kind !== "parity_check" && kind !== "qa_harness";

export const RefusalReason = z.enum([
  "illegal_transition",
  "actor_not_allowed",
  "cross_ticket_write",
  "no_session",
  "no_worktree",
  "missing_artifact",
  "source_changes",
  "diff_unverifiable",
  "facts_unavailable",
  "facts_deferred",
  "gate_not_passed",
  "unresolved_findings",
  "missing_evidence",
  "qa_not_passed",
  "children_open",
  "worktree_active",
  "not_from_human_qa",
  "missing_note",
  /** A gate the edge must not leave behind is still running (the stale-review guard, M3). */
  "gate_running",
  /** needs_human may not be cleared while the ticket has an open question. */
  "questions_open",
  /** Not every pull request of the ticket has merged, or its project does not close on merge. */
  "prs_not_merged",
]);
export type RefusalReason = z.infer<typeof RefusalReason>;
