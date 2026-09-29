import type { GateEvidence } from "../gates/schemas.js";
import type { TicketStatus } from "./statuses.js";
import type {
  Actor,
  GateFact,
  GateFacts,
  Known,
  LawFacts,
  LawInput,
  LawTicket,
  MergeFacts,
  TransitionInput,
} from "./types.js";

// Builders for the law tests. Test support only: excluded from coverage (vitest.config.ts).

export const TICKET = "T1";
export const OWN_SESSION = "S1";
export const PLAN = "docs/spikes/T1.md";

export const OPERATOR: Actor = { kind: "operator" };
export const ORCH: Actor = { kind: "orchestrator", sessionId: "S0" };
export const WORKER: Actor = { kind: "worker", sessionId: OWN_SESSION };
export const STRANGER: Actor = { kind: "worker", sessionId: "S9" };

/** Evidence as §10.3 requires it: core's GateEvidence, the one definition. */
export const EVIDENCE: GateEvidence = {
  command: "pnpm -w test",
  exit_code: 0,
  duration_ms: 1_200,
  cost_usd: 0.4,
  artifact_paths: ["logs/review.txt"],
  run_id: "R1",
  session_id: "S2",
  runner_id: "reviewer",
  runner_version: "1.0.0",
  executor_id: "local",
  model: null,
  subject: {
    repo_id: null,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    files: 2,
  },
  findings: {
    total: 0,
    by_severity: { blocker: 0, major: 0, minor: 0, nit: 0 },
    parse: "schema",
  },
  flags: {},
};

let gateSeq = 0;

export const gate = (
  o: Partial<GateFact> & Pick<GateFact, "kind">,
): GateFact => ({
  id: `G${(gateSeq += 1)}`,
  repoId: null,
  attempt: 1,
  round: 1,
  state: "passed",
  evidence: EVIDENCE,
  waiveReason: null,
  openSeverities: [],
  ...o,
});

/** The drift rounds 052 seeds as the most running before the operator decides. */
export const DRIFT_ROUNDS_MAX = 3;

/** The severities 007 seeds as blocking. */
export const BLOCKING: readonly string[] = ["blocker", "major"];

export const knownGates = (
  gates: readonly GateFact[],
  repos: readonly string[] = [],
  blockingSeverities: readonly string[] = BLOCKING,
  /** `when: "multi_repo"`: off by default, as `gates.parity_check` is (020). */
  multiRepo = false,
  /**
   * `when: "lint_configured"`: no repo by default, as `gates.lint_check` is off (024).
   * `[null]` is the repo-less lint gate of a ticket with no `ticket_repos`.
   */
  lintRepos: readonly (string | null)[] = [],
  /** `when: "qa_configured"`: off by default, as a project's `qa_mode` is `none` (036). */
  qaConfigured = false,
): Known<GateFacts> => ({
  state: "known",
  value: {
    gates,
    repos,
    blockingSeverities,
    multiRepo,
    lintRepos,
    qaConfigured,
    driftRoundsMax: DRIFT_ROUNDS_MAX,
  },
});

/** A ticket with no delivery, in a project that closes on merge (040's default). */
export const NO_MERGE: MergeFacts = { closeOnMerge: true, deliveries: [] };

/** One delivered repo's row, with a pull request unless `prUrl` says otherwise. */
export const deliveryRow = (
  repoId: string,
  state: string,
  prUrl: string | null = `https://forge.test/o/${repoId}/pull/1`,
  headSha: string | null = "b".repeat(40),
) => ({ repoId, state, prUrl, headSha });

/** Every pull request of the ticket merged: what `merge_close` needs. */
export const MERGED: MergeFacts = {
  closeOnMerge: true,
  deliveries: [deliveryRow("R1", "merged")],
};

/** A worker's own ticket with a live session and an active worktree; gates and QA land in M3. */
export const lawFacts = (o: Partial<LawFacts> = {}): LawFacts => ({
  actorSession: { id: OWN_SESSION, ticketId: TICKET, live: true },
  ticketSessions: [{ id: OWN_SESSION, ticketId: TICKET, live: true }],
  worktrees: [{ id: "W1", sessionId: OWN_SESSION, active: true }],
  children: [],
  priorStatus: null,
  gates: { state: "unavailable", detail: "gate facts land in M3" },
  qa: { state: "unavailable", detail: "qa facts land in M3" },
  merge: NO_MERGE,
  ...o,
});

export interface Case {
  readonly status: TicketStatus;
  readonly to: TicketStatus;
  readonly actor?: Actor;
  readonly ticket?: Partial<LawTicket>;
  readonly facts?: Partial<LawFacts>;
  readonly input?: TransitionInput;
}

export const lawTicket = (
  status: TicketStatus,
  o: Partial<LawTicket> = {},
): LawTicket => ({
  id: TICKET,
  status,
  non_trivial: false,
  plan_path: null,
  ...o,
});

export const lawInput = (c: Case): LawInput => ({
  ticket: lawTicket(c.status, c.ticket),
  actor: c.actor ?? WORKER,
  to: c.to,
  input: c.input ?? {},
  facts: lawFacts(c.facts),
});

/** One passing case per rule (every rule but `split`, which /transition never runs). */
export const POSITIVE: Readonly<Record<string, Case>> = {
  prioritize: { status: "backlog", to: "prioritized", actor: OPERATOR },
  staff: { status: "prioritized", to: "staffed", actor: ORCH },
  start_spike: { status: "staffed", to: "spiking" },
  submit_plan: {
    status: "spiking",
    to: "plan_review",
    ticket: { plan_path: PLAN },
    facts: { plan: { state: "present" }, diff: { state: "clean", files: 1 } },
  },
  approve_plan: { status: "plan_review", to: "planned" },
  revise_plan: {
    status: "plan_review",
    to: "spiking",
    facts: { gates: knownGates([]) },
  },
  start_build: { status: "planned", to: "building" },
  ask_human: { status: "building", to: "prioritized", actor: ORCH },
  request_review: { status: "building", to: "code_review" },
  request_fix: {
    status: "code_review",
    to: "review_fix",
    facts: { gates: knownGates([]) },
  },
  resubmit: { status: "review_fix", to: "code_review" },
  pass_review: {
    status: "code_review",
    to: "qa_harness",
    facts: { gates: knownGates([gate({ kind: "code_review" })]) },
  },
  pass_harness: {
    status: "qa_harness",
    to: "qa_human",
    actor: OPERATOR,
    input: { override_note: "harness lands in M3; checked by hand" },
  },
  fail_harness: { status: "qa_harness", to: "rework" },
  fail_human_qa: {
    status: "qa_human",
    to: "rework",
    actor: OPERATOR,
    input: { reason: "the save button is gone" },
  },
  pass_human_qa: { status: "qa_human", to: "done", actor: OPERATOR },
  rebuild: {
    status: "rework",
    to: "building",
    facts: { priorStatus: "qa_human" },
  },
  finish_rework: { status: "rework", to: "done", actor: OPERATOR },
  merge_close: {
    status: "qa_human",
    to: "done",
    actor: { kind: "supervisor" },
    facts: { merge: MERGED },
  },
  block: { status: "building", to: "blocked" },
  unblock: {
    status: "blocked",
    to: "building",
    actor: ORCH,
    facts: { priorStatus: "building" },
  },
  release: { status: "building", to: "handoff_pending", actor: OPERATOR },
  reclaim: {
    status: "handoff_pending",
    to: "building",
    actor: OPERATOR,
    facts: { priorStatus: "building" },
  },
  park: { status: "building", to: "parked", actor: ORCH },
  unpark: { status: "parked", to: "backlog", actor: OPERATOR },
  reject: { status: "backlog", to: "rejected", actor: OPERATOR },
  close_out: {
    status: "parked",
    to: "done",
    actor: OPERATOR,
    facts: { worktrees: [] },
    input: { reason: "reviewed and merged outside Bayon" },
  },
  close_split: {
    status: "split",
    to: "done",
    actor: ORCH,
    facts: { worktrees: [] },
  },
};
