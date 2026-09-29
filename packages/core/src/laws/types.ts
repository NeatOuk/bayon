import type { RefusalReason, TicketStatus } from "./statuses.js";

// What the laws read. Every fact is plain data gathered by the caller: in the write transaction
// (sessions, worktrees, children, prior status) or before it (the plan file and the git diff).

export type Actor =
  | { readonly kind: "operator" }
  | { readonly kind: "orchestrator" | "worker"; readonly sessionId: string }
  /**
   * The supervisor: the circuit breaker's `block` and the machine steps a
   * gate's decision settles, each through its named writer.
   */
  | { readonly kind: "supervisor" };

/** The ticket columns a law reads. */
export interface LawTicket {
  readonly id: string;
  readonly status: TicketStatus;
  readonly non_trivial: boolean;
  readonly plan_path: string | null;
}

export interface SessionFact {
  readonly id: string;
  readonly ticketId: string | null;
  /** Not in ENDED_STATES. */
  readonly live: boolean;
}

export interface WorktreeFact {
  readonly id: string;
  readonly sessionId: string | null;
  /** `worktrees.state = 'active'`. */
  readonly active: boolean;
}

export interface ChildFact {
  readonly id: string;
  readonly status: string;
}

export interface GateFact {
  readonly id: string;
  readonly kind: string;
  readonly repoId: string | null;
  readonly attempt: number;
  /**
   * `gates.round` (023): the review round that opened it. What lets a law ask whether
   * **this** round opened a gate of a kind, rather than whether one ever existed on the ticket.
   */
  readonly round: number;
  readonly state: string;
  /** `gates.evidence_json`, parsed (null when absent or not JSON); §10.3 says what it must hold. */
  readonly evidence: unknown;
  /** Why the operator waived it; a waived gate needs one. */
  readonly waiveReason: string | null;
  /** The severity of each of its findings still `open`. */
  readonly openSeverities: readonly string[];
  /**
   * `gates.subject_kind`: what nextStep reads to tell a `qa_harness` gate waiting on CI
   * (`CI_SUBJECT`) from one running a command. Absent where a caller has no row to read it from.
   */
  readonly subjectKind?: string;
}

/** A fact whose source may not exist yet: M1's gates and QA runs have no writer. */
export type Known<T> =
  | { readonly state: "known"; readonly value: T }
  | { readonly state: "unavailable"; readonly detail: string };

export interface GateFacts {
  /** Oldest attempt first. */
  readonly gates: readonly GateFact[];
  /** `ticket_repos`: every one needs its gate (§3.1). Empty means one repo-less gate. */
  readonly repos: readonly string[];
  /** `gates.blocking_severities`: only open findings at these block (M3). */
  readonly blockingSeverities: readonly string[];
  /**
   * What `when: "multi_repo"` reads: the ticket's workspace has more than one repo
   * **and** `gates.parity_check` is on (020 seeds it off). The same fact drives `planRound`, so a
   * gate is required exactly when a round opens it — the one property that keeps a multi-repo
   * ticket from stopping in code_review behind a gate that does not exist.
   */
  readonly multiRepo: boolean;
  /**
   * What `when: "lint_configured"` reads: the repos a `lint_check` opens for, empty
   * when `gates.lint_check` is off or no repo declares a `repos.lint_cmd` for the job to run. The
   * same fact drives `planRound`, so the round opens the gate exactly when the edge requires it —
   * and a fleet that has configured no lint command sees no change at all when the switch is
   * flipped.
   *
   * A **list**, not a flag: `lint_check` is per repo, so once `ticket_repos` has a
   * writer a flag read for one repo would open gates on repos it never asked about — a dep with no
   * lint command failing a gate the primary's command switched on. `[null]` is the repo-less gate
   * a ticket with no `ticket_repos` still opens.
   */
  readonly lintRepos: readonly (string | null)[];
  /**
   * What `when: "qa_configured"` reads: the ticket's project has
   * `workspaces.qa_mode = 'command'` (or, `'ci'`), so there is a harness for the
   * `qa_harness` gate to run, or a CI for it to wait on. The
   * same fact drives `planRound`, so `pass_review` opens the gate exactly when the QA round needs
   * one; a project with no harness opens none, and `pass_harness` stays the operator's.
   */
  readonly qaConfigured: boolean;
  /**
   * `gates.drift_rounds_max` (052 seeds 3): at this many review rounds running that
   * failed because the base moved, `reviewStep` stops sending the ticket back to fix.
   */
  readonly driftRoundsMax: number;
}

export interface QaFacts {
  /**
   * The latest `qa_runs.state` for the ticket, or null when there is none. A row is
   * written for every decision of a `qa_harness` gate, so the newest row always speaks for the
   * newest attempt — a stale `passed` from attempt 1 can never carry a failed attempt 2 past the
   * law.
   */
  readonly latest: string | null;
}

/** One `deliveries` row of the ticket, as `prs_merged` reads it. */
export interface DeliveryFact {
  readonly repoId: string;
  /** `deliveries.state`: pushed, pr_open, merged, closed or failed. */
  readonly state: string;
  /** Its pull request, or null when none was opened (a push-only delivery). */
  readonly prUrl: string | null;
  /**
   * `deliveries.head_sha`: the commit last delivered, or null when none was. A CI gate
   * judges a pull request only at a known head, so `harnessOwed` needs one.
   */
  readonly headSha: string | null;
}

/**
 * What `merge_close` reads: the ticket's project's `workspaces.close_on_merge`, and every
 * `deliveries` row of the ticket. Read in the write transaction, like every other fact.
 */
export interface MergeFacts {
  readonly closeOnMerge: boolean;
  readonly deliveries: readonly DeliveryFact[];
}

export type PlanFact =
  | { readonly state: "present" }
  | { readonly state: "missing" | "unverifiable"; readonly detail: string };

export type DiffFact =
  | { readonly state: "clean"; readonly files: number }
  | {
      readonly state: "dirty";
      readonly paths: readonly string[];
      readonly total: number;
    }
  | { readonly state: "unverifiable"; readonly detail: string }
  /** Not gathered on purpose: GET /tickets/:ref runs no git. */
  | { readonly state: "deferred" };

export interface LawFacts {
  /** The acting session, for a session actor; null for the operator or an unknown session. */
  readonly actorSession: SessionFact | null;
  /** Sessions whose `ticket_id` is this ticket. */
  readonly ticketSessions: readonly SessionFact[];
  /** Worktrees whose `ticket_id` is this ticket. */
  readonly worktrees: readonly WorktreeFact[];
  readonly children: readonly ChildFact[];
  /** The `from_status` of the latest transition into the current status. */
  readonly priorStatus: TicketStatus | null;
  readonly gates: Known<GateFacts>;
  readonly qa: Known<QaFacts>;
  /** The ticket's deliveries and its project's close_on_merge switch. */
  readonly merge: MergeFacts;
  /** Gathered before the transaction, only when the edge needs them (requiredFacts). */
  readonly plan?: PlanFact;
  readonly diff?: DiffFact;
}

/** What the caller says with a transition. */
export interface TransitionInput {
  readonly reason?: string;
  readonly override_note?: string;
  readonly blocked_reason?: string;
  readonly unblock_condition?: string;
}

export interface LawInput {
  readonly ticket: LawTicket;
  readonly actor: Actor;
  readonly to: TicketStatus;
  readonly input: TransitionInput;
  readonly facts: LawFacts;
}

export interface Refusal {
  readonly allowed: false;
  readonly rule: string;
  readonly reason: RefusalReason;
  readonly detail: string;
}

export type Decision =
  { readonly allowed: true; readonly rule: string } | Refusal;

/** A form field a transition takes. */
export type NoteField = "reason" | "override_note";

/** One entry of GET /tickets/:ref's `transitions` (contract 8). */
export interface TransitionOption {
  readonly to: TicketStatus;
  readonly rule: string;
  readonly allowed: boolean;
  readonly reason?: RefusalReason;
  readonly detail?: string;
  /** Facts checked only on submit, so the POST may still refuse. */
  readonly deferred?: readonly "no_source_changes"[];
  /** Notes the form should collect. */
  readonly input?: readonly NoteField[];
}
