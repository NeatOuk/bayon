import type { FindingSeverity, FindingStatus, GateState } from "@bayon/core";
import type { Generated, Selectable } from "kysely";

// Hand-written Kysely types for 003_work: the §4 work tables, their FTS tables and the two views
// (M1 amendments 3, 4, 5, 9). schema-columns-work.ts restates them at runtime, and schema.test.ts
// checks that against PRAGMA table_info. Conventions as in schema.ts.

export interface TicketReposTable {
  ticket_id: string;
  repo_id: string;
}

export interface TicketEventsTable {
  id: Generated<number>;
  ticket_id: string;
  ts: number;
  actor_kind: string;
  actor_id: string | null;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  payload_json: string | null;
}

export interface TicketLinksTable {
  ticket_id: string;
  kind: string;
  url: string | null;
  target_ticket_id: string | null;
  created_at: number;
}

/** `ticket_exports.state` (§10.5). `failed` puts the export on v_needs_attention (amendment 4). */
export type TicketExportState = "pending" | "synced" | "failed";

export interface TicketExportsTable {
  ticket_id: string;
  target: string;
  external_key: string | null;
  url: string | null;
  path: string | null;
  direction: Generated<string>;
  content_hash: string | null;
  state: Generated<TicketExportState>;
  last_synced_at: number | null;
  error: string | null;
}

/** 007's CHECK, widened by 024 for `lint_check`. core's `GateKind` is the same set. */
export type GateKind =
  | "plan_review"
  | "code_review"
  | "ce_review"
  | "parity_check"
  | "lint_check"
  | "qa_harness"
  | "human_qa";

export interface GatesTable {
  id: string;
  ticket_id: string;
  kind: GateKind;
  required: Generated<number>;
  /** 007's CHECK. */
  state: GateState;
  attempt: Generated<number>;
  /**
   * The review round that opened it (023): every gate one `planRound` call opens shares
   * a number, and a rerun or a timeout retry carries the round of the gate it follows. `attempt` is
   * per kind and says nothing about rounds, which is why "did THIS round open one" needs this.
   */
  round: Generated<number>;
  repo_id: string | null;
  reviewer_session_id: string | null;
  subject_kind: string;
  subject_ref: string;
  evidence_json: string | null;
  findings_total: number | null;
  findings_unresolved: number | null;
  waived_by: string | null;
  waive_reason: string | null;
  started_at: number | null;
  decided_at: number | null;
}

/** 036's CHECK. Three states, and `error` is the one that matters: nothing judged. */
export type QaRunState = "passed" | "failed" | "error";

/**
 * 036: one row per **decision** of a `qa_harness` gate, the supervisor's (§9.5's `qa`).
 * `facts.qa` reads the newest for a ticket, which is what `qa_passed` is judged on.
 */
export interface QaRunsTable {
  id: string;
  ticket_id: string;
  /** The gate whose decision wrote it; NULL only for a row no gate produced. */
  gate_id: string | null;
  /** `passed` | `failed` (the harness ran and said no) | `error` (nothing judged the code). */
  state: QaRunState;
  /** The project's own command, placeholders filled, as run; NULL when nothing ran. */
  command: string | null;
  exit_code: number | null;
  /** The report files the gate attached, JSON array of paths. */
  report_paths_json: Generated<string>;
  started_at: number;
  ended_at: number | null;
  /** 043: which kind of gate decided it, a harness command or the pull request's CI. */
  source: Generated<QaRunSource>;
}

/** 043's CHECK: what a `qa_runs` row's gate read. */
export type QaRunSource = "command" | "ci";

/**
 * 038's CHECK, widened by 040: what one repo's delivery got to. `merged` and
 * `closed` are its pull request's end, as the pull-request sweep read it from the forge.
 */
export type DeliveryState =
  "pushed" | "pr_open" | "merged" | "closed" | "failed";

/**
 * 037: one row per (ticket, repo) delivered, the supervisor's (§9.5 amendment).
 * Replaced in place under a unique index, so a re-run of the job reads what the last one reached
 * and does only what is left.
 */
export interface DeliveriesTable {
  id: string;
  ticket_id: string;
  repo_id: string;
  /** The ref that was delivered, as the worktree recorded it. */
  branch: string;
  /** The commit now on the remote; NULL while nothing has been pushed. */
  head_sha: string | null;
  /** The remote's HOST, never its URL: a URL can carry userinfo (§14). */
  remote_host: string | null;
  state: DeliveryState;
  pr_url: string | null;
  pr_number: number | null;
  /** Scrubbed and capped by its writer; NULL unless `state` is `failed`. */
  error: string | null;
  started_at: number;
  ended_at: number | null;
  /**
   * 039: the target it was pushed to, credentials removed; NULL on rows from before 039, which
   * went to origin_url. Part of the job's "already delivered" check.
   */
  remote_url: string | null;
  /** 040: when its pull request merged, epoch-millis as the forge reported it; NULL until then. */
  merged_at: number | null;
  /** 040: the forge login that merged it — a name, never a credential (§14). */
  merged_by: string | null;
  /**
   * 043: the CI sweep's last read of this pull request — the `ci` gate that read it,
   * the commit it read, and how many of the required checks had settled of how many. What the next
   * step's "n of m checks done" counts, only while `ci_sha` is still `head_sha`.
   */
  ci_gate_id: string | null;
  ci_sha: string | null;
  ci_done: number | null;
  ci_total: number | null;
}

export type { FindingSeverity };

export interface FindingsTable {
  id: string;
  gate_id: string;
  severity: FindingSeverity;
  category: string | null;
  file: string | null;
  line: number | null;
  summary: string;
  detail_md: string | null;
  /** 007's CHECK. */
  status: Generated<FindingStatus>;
  resolved_by_run_id: string | null;
  resolution_note: string | null;
  created_at: number;
  // 007: who resolved it and when; who waived it and why.
  resolved_by: string | null;
  resolved_at: number | null;
  waived_by: string | null;
  waive_reason: string | null;
}

export interface HandoffsTable {
  id: string;
  ticket_id: string;
  from_session_id: string | null;
  to_session_id: string | null;
  reason: string;
  phase_from: string | null;
  phase_to: string | null;
  facts_json: string;
  goal_line: string | null;
  decisions_md: string | null;
  traps_md: string | null;
  next_steps_md: string | null;
  open_questions_md: string | null;
  pointers_json: string | null;
  quality: Generated<string>;
  packet_path: string;
  packet_hash: string;
  tokens_est: number | null;
  accepted_at: number | null;
  created_at: number;
}

export interface MessagesTable {
  id: string;
  ts: number;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  kind: string;
  subject: string;
  body_md: string;
  ticket_id: string | null;
  correlation_id: string | null;
  requires_ack: number | null;
  delivered_at: number | null;
  read_at: number | null;
  acked_at: number | null;
}

export interface HumanRequestsTable {
  id: string;
  session_id: string | null;
  ticket_id: string | null;
  kind: string;
  question: string;
  context_md: string | null;
  options_json: string | null;
  batch_id: string | null;
  status: Generated<string>;
  answer_json: string | null;
  answered_by: string | null;
  asked_at: number;
  answered_at: number | null;
  expires_at: number | null;
  /**
   * 014: `<rule>:<subject>:<window>` of a system request; NULL for human_ask's. 030: a
   * staffing proposal's `staff:<ticket>:<role>:<run class>:<hand-off|->`.
   */
  dedupe_key: string | null;
  /** 030: a `staff_approval` request's proposal as JSON; NULL on every other row. */
  proposal_json: string | null;
}

export interface ApprovalsTable {
  id: string;
  session_id: string;
  run_id: string | null;
  tool: string;
  input_json: string;
  risk: string;
  decision: string | null;
  decided_by: string | null;
  policy_rule: string | null;
  requested_at: number;
  decided_at: number | null;
  timeout_at: number | null;
}

export interface KnowledgeTable {
  id: string;
  scope: string;
  scope_ref: string | null;
  kind: string;
  title: string;
  body_md: string;
  source_ticket_id: string | null;
  source_session_id: string | null;
  status: Generated<string>;
  promoted_path: string | null;
  hits: number | null;
  dedupe_key: string | null;
  created_at: number;
  reviewed_at: number | null;
}

export interface RoleBindingsTable {
  role: string;
  runner_id: string;
  model_tier: string | null;
  executor_id: string | null;
  profile_id: string | null;
  fallback_runner_id: string | null;
  require_distinct_from: string | null;
  updated_by: string | null;
  updated_at: number;
}

/** tickets_fts: external content on tickets; its rowid is tickets.num (amendment 3). */
export interface TicketsFtsTable {
  title: string;
  body_md: string;
}

/** knowledge_fts: its own copy of each entry; `ref` is knowledge.id. */
export interface KnowledgeFtsTable {
  ref: string;
  title: string;
  body_md: string;
}

/** handoffs_fts: its own copy of each packet's judgement; `ref` is handoffs.id. */
export interface HandoffsFtsTable {
  ref: string;
  goal_line: string | null;
  decisions_md: string | null;
  traps_md: string | null;
  next_steps_md: string | null;
}

/**
 * Why a row is on v_needs_attention: §4.1's arms whose tables exist, plus export_failed (M1
 * amendment 4) and split_candidate (004, M2 amendment i). handoff_pending means accepted_at IS
 * NULL, at any age (M2 amendment c). 012 (M4) adds budget_warn, worktree_dirty,
 * executor_unhealthy and backup_failed; 015 adds worktree_kept, exclusive of worktree_dirty;
 * 021 adds spawn_failed, the ticket whose spawn command died before any session row.
 * 035 narrows gate_stuck to the latest attempt a ticket still waits behind and adds advance_pending,
 * a round that passed with the ticket still in review: a machine step not taken.
 */
export const ATTENTION_ARMS = [
  "stale_session",
  "handoff_pending",
  "unstaffed_ready",
  "gate_stuck",
  "findings_open",
  "unanswered_human",
  "unread_message",
  "export_failed",
  "split_candidate",
  "budget_warn",
  "worktree_dirty",
  "executor_unhealthy",
  "backup_failed",
  "worktree_kept",
  "spawn_failed",
  "advance_pending",
] as const;
export type AttentionWhy = (typeof ATTENTION_ARMS)[number];

/**
 * Arms only a human can act on: §9.7's free no-op check skips them, so a
 * kept worktree never turns each due pulse into an LLM session. The context pack still lists them.
 *
 * The test is what the orchestrator's own toolset (SHIPPED_ALLOWLISTS.orchestrator: ticket_search,
 * ticket_get, ticket_create, ticket_update, ticket_comment, ticket_staff, mailbox_send, human_ask,
 * pulse_report, probe_run) can do about the row. `human_ask` never counts: escalating is what the
 * arm already does by existing, so counting it would make every arm actionable and this list empty.
 *
 * Every arm's decision, so a new one has to argue its own case:
 *
 * | arm                | the orchestrator can            | verdict     |
 * |--------------------|---------------------------------|-------------|
 * | stale_session      | release the holder, then staff  | pulse       |
 * | handoff_pending    | staff the successor that accepts| pulse       |
 * | unstaffed_ready    | ticket_staff, the whole job     | pulse       |
 * | gate_stuck         | nothing: the operator's gate    | human only  |
 * | findings_open      | staff a fix session             | pulse       |
 * | unanswered_human   | nothing: it is the human's turn | human only  |
 * | unread_message     | staff the agent that reads it   | pulse       |
 * | export_failed      | nothing: no export tool         | human only  |
 * | split_candidate    | ticket_create the children      | pulse       |
 * | budget_warn        | nothing: caps are operator-only | human only  |
 * | worktree_dirty     | nothing: a human keeps or cleans| human only  |
 * | worktree_kept      | nothing: a human decides        | human only  |
 * | executor_unhealthy | nothing: no executor tool       | human only  |
 * | backup_failed      | nothing: no backup tool         | human only  |
 * | spawn_failed       | ticket_staff, the whole job     | pulse       |
 * | advance_pending    | nothing: foreman's machine step | human only  |
 *
 * The four added here recover without the pulse or not at all: a budget's cap moves only through
 * the operator's audited door, an executor's health flips back on its own next check
 * or after the operator fixes it, a backup clears when a later one succeeds, and an
 * export is retried by its own interval timer or an operator's `export.run`. `unanswered_human`
 * is the sharpest case: the row exists *because* the fleet is waiting on the operator, so waking a
 * paid session to look at it is the one thing guaranteed not to help.
 *
 * `spawn_failed` (021) is the opposite case and the reason it is a pulse arm: the ticket
 * is out of `prioritized` with nothing holding it, `ticket_staff` takes every staffable status, and
 * one re-staff both repairs the ticket and clears the arm. Nothing an operator could add.
 *
 * `stale_session`'s row said "re-staff or re-plan its ticket" while the server refused exactly that
 * — a live session held the ticket, and a stale one is still live — so the arm was a notification
 * with nothing behind it and each due pulse paid for a session that could do nothing.
 * `ticket_staff` now takes the remedy: a holder silent past `watchdog.silent_ms`, the same row this
 * arm's own view reads (025), has its `session.handoff` queued by the refusal that names it, and
 * the call after the session ends staffs the successor. Two pulses, no operator write.
 *
 * `gate_stuck` was a pulse arm while a failed review meant "staff a fix session". Since an earlier change a
 * review that failed on the code sends the ticket back through foreman's own machine step, and one
 * that failed for any other reason (no reviewer, a broken reviewer, a timeout, a moved base) is the
 * operator's to rerun or configure: the pulse template says to leave it to them, and the orchestrator
 * has no gate tool. A gate running past its wall clock is the same. So a pulse woken for the arm could
 * only shrug. `advance_pending` (035) is a machine step foreman has not taken: only
 * foreman's sweep or the operator moves it, and the pulse is told never to take one itself.
 */
export const HUMAN_ONLY_ARMS = [
  "worktree_dirty",
  "worktree_kept",
  "budget_warn",
  "executor_unhealthy",
  "backup_failed",
  "export_failed",
  "unanswered_human",
  "gate_stuck",
  "advance_pending",
] as const satisfies readonly AttentionWhy[];

/**
 * The other side of the table: arms the orchestrator can act on, so a pulse for one is worth its
 * tokens. Kept beside HUMAN_ONLY_ARMS rather than derived from it so both halves are written down,
 * and a test asserts the two together cover ATTENTION_ARMS exactly once — a new arm has to pick a
 * side before it can ship.
 */
export const PULSE_ARMS = [
  "stale_session",
  "handoff_pending",
  "unstaffed_ready",
  "findings_open",
  "unread_message",
  "split_candidate",
  "spawn_failed",
] as const satisfies readonly AttentionWhy[];

/**
 * v_needs_attention (§4.1; rebuilt by 004, 005 and 012). `ref` is the row that needs attention: a
 * session, hand-off, ticket, gate, human request, message, budget, worktree, executor or backup
 * id, or an export's target. A row's key is (why, ref, ticket_id): for export_failed, ref alone
 * repeats across tickets ('markdown'). budget_warn, executor_unhealthy and backup_failed have no
 * ticket.
 *
 * 044: the view reads no clock. A timed arm carries `since` and `after_ms` and stands
 * only once `since < now - after_ms`; budget_warn is not in it. Read it through `attentionAt(now)`
 * (repos/attention.ts), never raw: the raw view lists timed rows at any age.
 */
export interface NeedsAttentionView {
  why: AttentionWhy;
  ref: string;
  ticket_id: string | null;
  /** When a timed arm's wait began (epoch ms); null on an arm listed as soon as it matches. */
  since: number | null;
  /** How long past `since` a timed arm's row waits before it stands; null: it stands at once. */
  after_ms: number | null;
}

/** v_ticket_economics (§4.1, §8.9). Cost, waste, review rounds and hand-offs are derived (amendment 9). */
export interface TicketEconomicsView {
  id: string;
  num: number;
  title: string;
  status: string;
  complexity_tier: string;
  cost_usd: number;
  cost_wasted_usd: number;
  review_rounds: number;
  /** Hand-offs that say the ticket may be too big (§7.5): `phase_change` rows are not among them. */
  handoff_count: number;
  /** Phase boundaries crossed (§7.1, 022): progress, counted apart from the sizing signal. */
  phase_handoff_count: number;
  sessions: number;
  tokens: number;
  cache_ratio: number | null;
}

export interface WorkDB {
  ticket_repos: TicketReposTable;
  qa_runs: QaRunsTable;
  deliveries: DeliveriesTable;
  ticket_events: TicketEventsTable;
  ticket_links: TicketLinksTable;
  ticket_exports: TicketExportsTable;
  gates: GatesTable;
  findings: FindingsTable;
  handoffs: HandoffsTable;
  messages: MessagesTable;
  human_requests: HumanRequestsTable;
  approvals: ApprovalsTable;
  knowledge: KnowledgeTable;
  role_bindings: RoleBindingsTable;
  tickets_fts: TicketsFtsTable;
  knowledge_fts: KnowledgeFtsTable;
  handoffs_fts: HandoffsFtsTable;
  v_needs_attention: NeedsAttentionView;
  v_ticket_economics: TicketEconomicsView;
}

export type TicketEventRow = Selectable<TicketEventsTable>;
export type TicketLinkRow = Selectable<TicketLinksTable>;
export type TicketExportRow = Selectable<TicketExportsTable>;
export type GateRow = Selectable<GatesTable>;
export type QaRunRow = Selectable<QaRunsTable>;
export type DeliveryRow = Selectable<DeliveriesTable>;
export type FindingRow = Selectable<FindingsTable>;
export type HandoffRow = Selectable<HandoffsTable>;
export type MessageRow = Selectable<MessagesTable>;
export type HumanRequestRow = Selectable<HumanRequestsTable>;
export type KnowledgeRow = Selectable<KnowledgeTable>;
/** A row standing on v_needs_attention at a given now: what `attentionAt(now)` lists. */
export type NeedsAttentionRow = Pick<
  Selectable<NeedsAttentionView>,
  "why" | "ref" | "ticket_id"
>;
export type RoleBindingRow = Selectable<RoleBindingsTable>;
export type TicketEconomicsRow = Selectable<TicketEconomicsView>;
