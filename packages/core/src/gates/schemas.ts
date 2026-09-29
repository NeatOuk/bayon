import { z } from "zod";
import { QueuedReason } from "../admission-gates.js";
import { BindingRole } from "./roles.js";

// The gate contracts (§10.3, M3 amendments): gate and finding states, why a gate failed, and the
// evidence a decided gate keeps in `gates.evidence_json`. Plain data, parsed at every boundary.

/** `gates.state` (007's CHECK). running → passed | failed; running | failed → waived. */
export const GateState = z.enum(["running", "passed", "failed", "waived"]);
export type GateState = z.infer<typeof GateState>;

/** `findings.severity` (003's CHECK), most severe first. */
export const FindingSeverity = z.enum(["blocker", "major", "minor", "nit"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

/** `findings.status` (007's CHECK). Resolving names the fixing run; waiving names a reason. */
export const FindingStatus = z.enum(["open", "resolved", "waived"]);
export type FindingStatus = z.infer<typeof FindingStatus>;

/** How a reviewer's findings were read: against the output schema, or by the heuristic parser. */
export const FindingsParse = z.enum(["schema", "heuristic"]);
export type FindingsParse = z.infer<typeof FindingsParse>;

/** Why a gate failed: the evidence's `reason`, and verdict()'s. A closed set a caller can act on. */
export const GateFailReason = z.enum([
  /** No terminal event inside the gate's wall clock, min(run class, gates.wall_clock_ms) (§5.2). */
  "timeout",
  /** The supervisor restarted while the gate ran; the next round is attempt n+1. */
  "supervisor_restart",
  /** pickReviewer found no enabled, certified, gate-eligible runner. */
  "no_reviewer",
  /** The reviewer ended in error, or its schema output did not parse. */
  "reviewer_error",
  /** The evidence fails GateEvidence: no evidence, no pass (§10.3, Invariant 10). */
  "missing_evidence",
  /** A plan_review subject changed source files (M3 amendment i). */
  "source_changes",
  /** The base moved under the review and gates.base_drift is "fail". */
  "base_drift",
  /** Open findings at gates.blocking_severities. */
  "blocking_findings",
  /** The operator moved the ticket on, or parked, rejected or split it, while the gate ran (M3). */
  "superseded",
]);
export type GateFailReason = z.infer<typeof GateFailReason>;

const Count = z.int().nonnegative();
const Id = z.string().min(1);
/** A full git object id: SHA-1 or SHA-256. */
const Sha = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "a full git object id");

/** Findings per severity, every severity present. */
export const SeverityCounts = z.object({
  blocker: Count,
  major: Count,
  minor: Count,
  nit: Count,
});
export type SeverityCounts = z.infer<typeof SeverityCounts>;

/** What was reviewed: one repo's base..head, pinned before the reviewer starts. */
export const GateSubject = z.object({
  repo_id: Id.nullable(),
  base_sha: Sha,
  head_sha: Sha,
  /** The number of files changed in base..head. */
  files: Count,
});
export type GateSubject = z.infer<typeof GateSubject>;

/** Source files the subject changed (plan_review, amendment i): capped paths and the true total. */
export const SourceChanges = z
  .object({ paths: z.array(Id), total: Count })
  .refine((s) => s.paths.length <= s.total, "paths outnumber total");
export type SourceChanges = z.infer<typeof SourceChanges>;

const sumOf = (c: SeverityCounts): number =>
  c.blocker + c.major + c.minor + c.nit;

/** The most report files one `qa_harness` gate attaches (core `QA_REPORTS_MAX`, restated as a bound). */
const QA_REPORTS_BOUND = 20;

/**
 * What a `qa_harness` gate's run was, in structure as well as in the prose of `command` ( * §10.4): the project's own command as run (placeholders filled), its exit status, and the reports
 * its globs matched, copied into the gate's artifacts. `decideGate` writes the `qa_runs` row from
 * this, so the gate's evidence and the QA fact the laws read have one source.
 */
export const QaEvidence = z.strictObject({
  command: z.string().min(1),
  /** Null when the harness never started, or died on a signal. */
  exit_code: z.int().nullable(),
  started_at: Count,
  ended_at: Count,
  reports: z.array(Id).max(QA_REPORTS_BOUND),
  /**
   * The reports that are **not text**, and so were copied byte for byte without the secret scrub
   * every other report and the whole of the harness's output went through (§14, Invariant 11). A
   * subset of `reports`, absent when there are none. Flagged rather than dropped: an operator may
   * need a screenshot or a coverage database, and must know which files were not cleaned.
   */
  binary_reports: z.array(Id).max(QA_REPORTS_BOUND).optional(),
});
export type QaEvidence = z.infer<typeof QaEvidence>;

/** §10.3 evidence: without all of it a gate cannot be passed (Invariant 10). */
export const GateEvidence = z.object({
  command: z.string().min(1),
  /**
   * The reviewer or script process's exit status as the executor observed it (ExitStatus): an
   * observed fact, never inferred from tool output, so always known for a process. A gate that
   * failed before it had a process carries GateFailure, which has none.
   */
  exit_code: z.int(),
  duration_ms: Count,
  cost_usd: z.number().nonnegative(),
  artifact_paths: z.array(Id).min(1),
  run_id: Id,
  session_id: Id,
  runner_id: Id,
  runner_version: Id.nullable(),
  executor_id: Id,
  model: Id.nullable(),
  subject: GateSubject,
  findings: z
    .object({ total: Count, by_severity: SeverityCounts, parse: FindingsParse })
    .refine(
      (f) => f.total === sumOf(f.by_severity),
      "findings.total is the sum of by_severity",
    ),
  flags: z.object({
    /** Reviewer and builder share a runner (§9.8). */
    single_runner_review: z.boolean().optional(),
    /** The bound runner a fallback replaced. */
    fallback_from: Id.optional(),
    /** The base moved while the review ran. */
    base_drift: z.boolean().optional(),
  }),
  source_changes: SourceChanges.optional(),
  qa: QaEvidence.optional(),
  /** Set on a gate that failed after it gathered evidence. */
  reason: GateFailReason.optional(),
});
export type GateEvidence = z.infer<typeof GateEvidence>;

/** The most checks a `ci` gate's evidence row carries; the whole list is its artifact. */
export const CI_EVIDENCE_CHECKS_MAX = 200;
/** A check name as a forge reports it, cleaned (core `ciCheckName`): what a finding may quote. */
export const CI_CHECK_NAME_MAX = 200;
/** The most required check names a project may configure (`qa_ci_checks_json`). */
export const CI_REQUIRED_MAX = 50;
/** The most pull requests one ticket's `ci` gate reads: one per delivered repo. */
const CI_HEADS_BOUND = 64;
/**
 * A required-check entry: a check name, or `<repo_id>:<name>` for one repo's check only (core
 * `ciRequirements`) — a name's room plus a repo id's.
 */
export const CI_REQUIRED_ENTRY_MAX = CI_CHECK_NAME_MAX + 65;

/**
 * One check on a commit, as a forge reports it once normalized: a check run or a
 * commit status, its state folded into five. `url` is kept only when it is a page on the remote's
 * own forge; otherwise the name alone says which check it was. Which repo and commit it is on is
 * the group it sits in (`CiRepoEvidence`), never a field of its own.
 */
export const CiCheckState = z.enum([
  "pending",
  "success",
  "failure",
  "neutral",
  "skipped",
]);
export type CiCheckState = z.infer<typeof CiCheckState>;

export const CiCheck = z.strictObject({
  name: z.string().min(1).max(CI_CHECK_NAME_MAX),
  state: CiCheckState,
  url: z.string().min(1).nullable(),
});
export type CiCheck = z.infer<typeof CiCheck>;

/**
 * One repo's read: the head judged, the pull request it is on, its checks — the first
 * of them up to the row's budget, every one in the artifact — and how many it reported in all.
 */
export const CiRepoEvidence = z
  .strictObject({
    repo_id: Id,
    sha: Sha,
    pr_url: z.string().min(1),
    checks: z.array(CiCheck).max(CI_EVIDENCE_CHECKS_MAX),
    total: Count,
  })
  .refine((r) => r.checks.length <= r.total, "checks outnumber total");
export type CiRepoEvidence = z.infer<typeof CiRepoEvidence>;

/**
 * What a `ci` gate read, repo by repo — each repo is judged on its own checks — and the
 * required-check entries the project named (empty: every check each repo reports). The rows hold
 * at most `CI_EVIDENCE_CHECKS_MAX` checks between them; the artifact holds all of them.
 */
export const CiEvidence = z
  .strictObject({
    repos: z.array(CiRepoEvidence).min(1).max(CI_HEADS_BOUND),
    required: z
      .array(z.string().min(1).max(CI_REQUIRED_ENTRY_MAX))
      .max(CI_REQUIRED_MAX),
  })
  .refine(
    (c) =>
      c.repos.reduce((n, r) => n + r.checks.length, 0) <=
      CI_EVIDENCE_CHECKS_MAX,
    "more checks kept than the row's budget",
  );
export type CiEvidence = z.infer<typeof CiEvidence>;

/**
 * §10.3 evidence for a `qa_harness` gate that waited on the forge's checks instead of running
 * anything. It has no run, session, runner or executor to name, so it is not a
 * `GateEvidence` with those faked: it carries the five §10.3 facts — a command line (`ci checks
 * <names>`), an exit code (0 every required check passed, 1 one failed), the wait's duration, a cost
 * of 0 and the artifact holding the whole check list — and what it read. `verdict()` judges it.
 */
export const CiGateEvidence = z.strictObject({
  command: z.string().min(1),
  exit_code: z.int(),
  duration_ms: Count,
  cost_usd: z.number().nonnegative(),
  artifact_paths: z.array(Id).min(1),
  ci: CiEvidence,
  /** Set on a gate that failed after it gathered evidence. */
  reason: GateFailReason.optional(),
});
export type CiGateEvidence = z.infer<typeof CiGateEvidence>;

/** Why a runner the reviewer pick considered could not review. */
export const ReviewerExclusion = z.enum([
  /** The supervisor has no adapter loaded for it. */
  "no_adapter",
  "not_enabled",
  /** No live certification of the model it would run, on the executor it would run on. */
  "not_certified",
  /** Certified there, but not gate-eligible. */
  "not_gate_eligible",
  /** code_review reads schema findings only (): the runner has no outputSchema. */
  "needs_output_schema",
  /** No enabled `kind='reviewer'` agent of the runner. */
  "no_reviewer_agent",
]);
export type ReviewerExclusion = z.infer<typeof ReviewerExclusion>;

/** The most runners a no_reviewer failure lists. */
export const REVIEWER_SEARCH_MAX = 32;

/**
 * What a no_reviewer pick looked at: the role (`builder` for ce_review, which reviews as the
 * builder's runner), the executor, whether the runners were named (by the role's binding, or as the
 * builder's) rather than every runner, and each runner that could not review, with why.
 */
export const ReviewerSearch = z.strictObject({
  role: BindingRole,
  executor_id: Id,
  bound: z.boolean(),
  runners: z
    .array(
      z.strictObject({
        runner_id: Id,
        /** The model the reviewer would run there: what certification was checked on;
         * null when its binding and profile name none. Absent in records made before. */
        model: z.string().nullable().optional(),
        /** Its session would run compressed (spec M12): the certificate checked was the
         * compression-on one. Absent: off, and in records made before. */
        compression: z.boolean().optional(),
        why: z.array(ReviewerExclusion).min(1),
      }),
    )
    .max(REVIEWER_SEARCH_MAX),
});
export type ReviewerSearch = z.infer<typeof ReviewerSearch>;

/** A pre-review failure's detail beyond this is cut (the whole of it stays in the supervisor log). */
export const GATE_FAILURE_DETAIL_MAX = 1000;

/**
 * A gate that failed before it had evidence (a timeout, a restart, no reviewer): the reason, and
 * on a timeout the admission gate that held its reviewer queued, if one did.
 * One that failed before a review says why: a detail line; for no_reviewer, the runners
 * it considered; for base_drift, the pinned base and the tip.
 */
export const GateFailure = z.strictObject({
  reason: GateFailReason,
  queued_reason: QueuedReason.optional(),
  detail: z.string().min(1).max(GATE_FAILURE_DETAIL_MAX).optional(),
  considered: ReviewerSearch.optional(),
  drift: z.strictObject({ base_sha: Sha, tip_sha: Sha }).optional(),
});
export type GateFailure = z.infer<typeof GateFailure>;

/**
 * What `gates.evidence_json` holds: full evidence (a process's, or a `ci` gate's), or, on a failed
 * gate, the reason alone.
 */
export const StoredGateEvidence = z.union([
  GateEvidence,
  CiGateEvidence,
  GateFailure,
]);
export type StoredGateEvidence = z.infer<typeof StoredGateEvidence>;
