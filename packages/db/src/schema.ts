import type {
  DeliveryMode,
  DeliveryMoment,
  DocsKind,
  ErrorClass,
  EventKind,
  ExitReason,
  ModelTier,
  QaMode,
  RunState,
  SessionState,
  WorktreeKeptReason,
} from "@bayon/core";
import type { Generated, Selectable } from "kysely";
import type { FleetDB } from "./schema-fleet.js";
import type { JiraPushDB } from "./schema-jira-push.js";
import type { NotifyDB } from "./schema-notify.js";
import type { PulseDB } from "./schema-pulse.js";
import type { RunnerUpdatesDB } from "./schema-runner-updates.js";
import type { WorkDB } from "./schema-work.js";

// Hand-written Kysely types for 001_spine (003_work's are in schema-work.ts and 004_pulse's in
// schema-pulse.ts, joined into DB below). schema-columns.ts restates them at runtime, and
// schema.test.ts checks that against PRAGMA table_info, so they cannot drift from the DDL.
// JSON columns (*_json) are JSON text; the repositories serialize and parse them.
// Generated<T> marks a NOT NULL column with a DEFAULT: optional on insert.

export interface RunnersTable {
  id: string;
  kind: string;
  adapter: string;
  version_detected: string | null;
  caps_json: string;
  defaults_json: Generated<string>;
  conformance_version: string | null;
  conformance_passed_at: number | null;
  conformance_report_path: string | null;
  gate_eligible: Generated<number>;
  enabled: Generated<number>;
  /** 007: the last conformance report's summary, JSON (§15). */
  conformance_json: string | null;
}

/** 009: a runner's conformance certification on one executor (§15). */
export interface RunnerCertificationsTable {
  runner_id: string;
  executor_id: string;
  /** 045: the models row the certificate was earned on: part of the key. */
  model_id: string;
  /** 049: 1 when earned with context compression on (spec M12): part of the key. */
  compression: Generated<number>;
  /** 045: the model string the suite spawned, pinned like runner_version. */
  model: string;
  runner_version: string;
  suite_version: string;
  kit_hash: string;
  caps_hash: string;
  /** core ConformanceResult JSON, as certify() returned it. */
  result_json: string;
  report_path: string | null;
  gate_eligible: Generated<number>;
  /** Unattended allowed: tests 9, 10 and 14 passed. NULL otherwise, and once decertified. */
  passed_at: number | null;
  certified_at: number;
  decertified_at: number | null;
  decertified_reason: string | null;
}

/** 009: a conformance probe's token while a suite runs (test 11). */
export interface ConformanceProbesTable {
  id: string;
  token_hash: string;
  toolset_hash: string;
  runner_id: string;
  executor_id: string;
  /** 045: the run's model; null for a probe opened before 045. */
  model_id: string | null;
  created_at: number;
  expires_at: number;
}

export interface ExecutorsTable {
  id: string;
  kind: "local" | "container" | "remote";
  config_json: string;
  slots: Generated<number>;
  egress_policy: Generated<string>;
  trust: Generated<string>;
  health: Generated<string>;
  health_checked_at: number | null;
  enabled: Generated<number>;
  /** 009: what the last health check measured, JSON (§6.1). */
  health_detail: string | null;
}

export interface ModelsTable {
  id: string;
  runner_id: string;
  tier: ModelTier;
  model: string;
  effort: string | null;
  price_in_per_mtok: number | null;
  price_out_per_mtok: number | null;
  price_cache_read_per_mtok: number | null;
  price_cache_write_per_mtok: number | null;
  context_tokens: number | null;
  active: Generated<number>;
  retired_at: number | null;
  /** 046: who owns the row — a registration at boot, or the operator. */
  source: Generated<ModelSource>;
  /** 046: the row's settings for its runner's adapter, which alone reads them; never a secret. */
  settings_json: Generated<string>;
  /** 050: registered on standby, not its tier's active row; 1 or 0. */
  standby: Generated<number>;
}

/** 046: `models.source`. Boot writes `adapter` rows only and never touches an `operator` one. */
export type ModelSource = "adapter" | "operator";

export interface ReposTable {
  id: string;
  name: string;
  origin_url: string | null;
  mirror_path: string;
  default_base_branch: Generated<string>;
  image: string | null;
  test_cmd: string | null;
  lint_cmd: string | null;
  build_cmd: string | null;
  install_cmd: string | null;
  doctrine_paths_json: Generated<string>;
  has_submodules: Generated<number>;
  /** 039: where delivery pushes; NULL pushes to origin_url (M8.1). Never carries a credential. */
  push_url: string | null;
}

export interface WorkspacesTable {
  id: string;
  name: string;
  kind: "single" | "multi" | "submodule";
  default_executor_id: string | null;
  default_runner_id: string | null;
  /** 029: 1 while the project is paused: nothing new starts in it. */
  paused: Generated<number>;
  /** 030: 1 while the project's orchestrator only proposes its staffing. */
  staff_approval: Generated<number>;
  /** 033: the Jira site the project mirrors, `https://<name>.atlassian.net`. */
  jira_url: string | null;
  /** 033: the Atlassian account its token belongs to; set with jira_url. */
  jira_email: string | null;
  /** 033: the query whose To Do issues it mirrors; set with jira_url. */
  jira_jql: string | null;
  /** 036: the project's QA harness: `none`, `command` or `pending`; 043 adds `ci`. */
  qa_mode: Generated<QaMode>;
  /** 036: the harness command, argv with no shell; required while `qa_mode` is `command`. */
  qa_cmd: string | null;
  /** 036: the harness's own wall clock; NULL is core's QA_TIMEOUT_DEFAULT_MS. */
  qa_timeout_ms: number | null;
  /** 036: host-store secret NAMES to put in the harness's env, JSON array. Never a value (§14). */
  qa_secrets_json: string | null;
  /** 036: globs, relative to the worktree, attached to the gate as evidence; JSON array. */
  qa_reports_json: string | null;
  /** 036: a path or glob to a JUnit XML report, for a finding per failed case. */
  qa_junit: string | null;
  /** 037: where the project's documentation lives: `none` or `confluence`. */
  docs_kind: Generated<DocsKind>;
  /** 037: the documentation site, `https://<name>.atlassian.net`; set while `docs_kind` is not `none`. */
  docs_url: string | null;
  /** 037: the Atlassian account its token belongs to; set with docs_url. */
  docs_email: string | null;
  /** 037: the space keys an agent may read, JSON array; empty is any the account can read. */
  docs_spaces_json: string | null;
  /** 038: how this project's finished work leaves: `none`, `push`, `pull_request`. */
  delivery_mode: Generated<DeliveryMode>;
  /** 038: the moment it leaves at: `review_passed` or `done`. */
  delivery_when: Generated<DeliveryMoment>;
  /** 040: 1 closes a ticket once all of its pull requests merge; 0 only records it. */
  close_on_merge: Generated<number>;
  /** 041: the Jira status each moment moves a mirrored issue to, JSON (core JiraStatusMap); NULL: none. */
  jira_status_map_json: string | null;
  /** 041: 1 comments each delivered pull request (and who merged it) on the issue. */
  jira_comment_prs: Generated<number>;
  /** 043: `ci` mode's required check names, JSON array; NULL or [] is every check. */
  qa_ci_checks_json: string | null;
  /** 043: how long a `ci` gate waits for its checks; NULL is core's QA_CI_TIMEOUT_DEFAULT_MS. */
  qa_ci_timeout_ms: number | null;
  /**
   * 047: when delivery_mode last left `none`, epoch ms; NULL while it delivers nothing.
   * Only a moment a ticket reaches at or after it is delivered.
   */
  delivery_since: number | null;
  /** 048: the tier the project's plan step (`spike`) runs; NULL inherits. */
  plan_tier: ModelTier | null;
  /** 048: the tier its build step (`build`, `build_complex`, `fix`) runs; NULL inherits. */
  build_tier: ModelTier | null;
  /** 048: the tier its review step (`review`, every LLM gate's session) runs; NULL inherits. */
  review_tier: ModelTier | null;
  /**
   * 049: 1 while the project's sessions run their model calls through the context proxy (spec M12,
   *), where the adapter, the executor and the role allow it; 0 (the default) is off.
   */
  context_compression: Generated<number>;
}

export interface WorkspaceReposTable {
  workspace_id: string;
  repo_id: string;
  rel_path: string;
  role: Generated<string>;
  submodule_path: string | null;
}

/** `worktrees.state` (§9.2). Dirty and orphan worktrees are kept, never deleted. */
export type WorktreeState =
  "active" | "idle" | "dirty" | "merged" | "orphan" | "removed";

export interface WorktreesTable {
  id: string;
  session_root: string;
  workspace_id: string;
  repo_id: string;
  path: string;
  branch: string;
  base_sha: string;
  head_sha: string | null;
  submodule_shas_json: string | null;
  ticket_id: string | null;
  session_id: string | null;
  state: WorktreeState;
  created_at: number;
  last_used_at: number | null;
  /** Why the sweep kept it for a human (015; NULL when nothing to flag. */
  kept_reason: WorktreeKeptReason | null;
  kept_detail: string | null;
}

export interface AgentsTable {
  id: string;
  name: string;
  kind:
    "orchestrator" | "builder" | "reviewer" | "investigator" | "qa" | "util";
  runner_id: string;
  executor_id: string | null;
  profile_id: string | null;
  mission_id: string | null;
  workspace_id: string | null;
  session_strategy: Generated<string>;
  pulse_mode: Generated<"interval" | "on_idle" | "hybrid" | "manual">;
  pulse_interval_ms: Generated<number>;
  pulse_debounce_ms: Generated<number>;
  pulse_min_gap_ms: Generated<number>;
  pulse_max_per_hour: Generated<number>;
  pulse_jitter_pct: Generated<number>;
  max_concurrency: Generated<number>;
  enabled: Generated<number>;
  created_at: number;
}

export interface MissionsTable {
  id: string;
  agent_name: string;
  version: number;
  who_md: string;
  what_md: string;
  how_md: string;
  laws_md: string;
  rendered_md: string;
  hash: string;
  note: string | null;
  created_at: number;
  created_by: string;
}

export interface ProfilesTable {
  id: string;
  name: string;
  runner_id: string;
  model_tier: string;
  permission_json: Generated<string>;
  sandbox_json: Generated<string>;
  env_json: Generated<string>;
  secret_refs_json: Generated<string>;
  mcp_json: Generated<string>;
  hooks_json: Generated<string>;
  skills_refs_json: Generated<string>;
  tool_allowlist_json: Generated<string>;
  version: number;
  hash: string;
  created_at: number;
}

export interface PromptTemplatesTable {
  id: string;
  name: string;
  version: number;
  body: string;
  hash: string;
  section_order_json: string;
  budget_json: string;
  created_at: number;
}

export interface RunClassesTable {
  name: string;
  context_tokens_cap: number;
  max_turns: number;
  max_tool_calls: number;
  wall_clock_ms: number;
  cost_cap_usd: number;
  handoff_at_turns: number;
  handoff_at_context_pct: Generated<number>;
  default_tier: ModelTier;
}

export interface SessionsTable {
  id: string;
  agent_id: string;
  ticket_id: string | null;
  role: string;
  run_class: string;
  runner_id: string;
  runner_version: string | null;
  runner_session_id: string | null;
  executor_id: string;
  executor_ref: string | null;
  model: string | null;
  model_tier: string | null;
  effort: string | null;
  workspace_id: string | null;
  session_root: string;
  home_dir: string;
  config_hash: string;
  mission_hash: string | null;
  doctrine_hash: string | null;
  toolset_hash: string | null;
  state: SessionState;
  predecessor_session_id: string | null;
  handoff_in_id: string | null;
  handoff_out_id: string | null;
  raw_log_path: string;
  pty_log_path: string | null;
  tmux_target: string | null;
  /** Byte in raw_log_path where the current runner process's output starts (spec amendment). */
  raw_segment_offset: number | null;
  mcp_token_hash: string;
  attach_lease_owner: string | null;
  attach_lease_expires_at: number | null;
  turns: Generated<number>;
  tool_calls: Generated<number>;
  cost_usd: Generated<number>;
  cost_source: Generated<string>;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  context_peak_tokens: number | null;
  last_event_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  exit_reason: ExitReason | null;
  error_class: ErrorClass | null;
  error_message: string | null;
  created_at: number;
  /** 007: the gate a reviewer session runs. */
  gate_id: string | null;
  /** 007: the bound runner a fallback replaced (§9.8). */
  fallback_from_runner_id: string | null;
  /** 012: why a pending session is queued (§9.1): a queue-side AdmissionGate value (M4-b). */
  queued_reason: string | null;
  /** 013: the zod-parsed session.spawn payload, while pending, for re-admission. */
  spawn_request_json: string | null;
  /** 032: a pending "take over after this step": the lease owner it will mint. */
  attach_intent_owner: string | null;
  /** 032: when that takeover was asked; NULL exactly when attach_intent_owner is. */
  attach_intent_at: number | null;
  /**
   * 049: the context ruleset the session was spawned with (spec M12), a pin like `model`;
   * NULL: its model calls are not compressed. An adopt resumes on it.
   */
  context_ruleset: string | null;
  /** 049: the session's estimated saving (chars/4), summed from its spend rows; NULL until one. */
  tokens_saved: number | null;
}

export interface RunsTable {
  id: string;
  session_id: string;
  seq: number;
  trigger: string;
  template_id: string | null;
  prompt_path: string;
  prompt_tokens_est: number | null;
  prompt_tokens_actual: number | null;
  prompt_hash: string;
  context_hash: string;
  mission_hash: string | null;
  doctrine_hash: string | null;
  toolset_hash: string | null;
  config_hash: string | null;
  model: string | null;
  effort: string | null;
  base_sha: string | null;
  truncated_sections_json: string | null;
  state: RunState;
  attempt: Generated<number>;
  wasted: Generated<number>;
  started_at: number;
  ended_at: number | null;
  tool_calls: number | null;
  error_class: ErrorClass | null;
  error_message: string | null;
  idempotency_key: string | null;
  /** 013: the wall clock the run armed (§5.2); NULL for runs before 013. */
  wall_clock_ms: number | null;
}

export interface EventsTable {
  id: Generated<number>;
  session_id: string;
  run_id: string | null;
  ts: number;
  kind: EventKind;
  runner_type: string;
  tool_name: string | null;
  status: string | null;
  exit_code: number | null;
  text: string | null;
  payload_json: string | null;
  payload_path: string | null;
  bytes_original: number | null;
  truncated: Generated<number>;
  raw_offset: number | null;
}

export interface SpendTable {
  id: string;
  run_id: string;
  session_id: string;
  ticket_id: string | null;
  gate_id: string | null;
  pulse_id: string | null;
  phase: string;
  runner_id: string;
  model: string;
  tokens_in: Generated<number>;
  tokens_out: Generated<number>;
  tokens_cache_read: Generated<number>;
  tokens_cache_write: Generated<number>;
  tokens_tool_result: number | null;
  /** 049: the run's estimated saving from context compression (chars/4); NULL when not proxied. */
  tokens_saved: number | null;
  cost_usd: number;
  cost_source: string;
  cache_hit_ratio: number | null;
  wasted: Generated<number>;
  ts: number;
}

export interface TicketsTable {
  id: string;
  num: number;
  title: string;
  body_md: Generated<string>;
  acceptance_md: Generated<string>;
  type: "bug" | "feature" | "chore" | "docs" | "spike" | "followup";
  status: string;
  priority: Generated<number>;
  non_trivial: Generated<number>;
  complexity_score: Generated<number>;
  complexity_tier: Generated<string>;
  complexity_factors_json: string | null;
  workspace_id: string | null;
  epic_id: string | null;
  origin: string;
  origin_ref: string | null;
  origin_fingerprint: string | null;
  needs_human: Generated<number>;
  blocked_reason: string | null;
  unblock_condition: string | null;
  owner_session_id: string | null;
  branch: string | null;
  plan_path: string | null;
  pr_url: string | null;
  review_rounds: Generated<number>;
  handoff_count: Generated<number>;
  parent_ticket_id: string | null;
  split_depth: Generated<number>;
  split_reason: string | null;
  split_from_handoff_id: string | null;
  children_total: Generated<number>;
  children_done: Generated<number>;
  cost_usd: Generated<number>;
  cost_wasted_usd: Generated<number>;
  version: Generated<number>;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export type CommandState = "pending" | "claimed" | "done" | "failed";

export interface CommandsTable {
  id: string;
  ts: number;
  type: string;
  payload_json: string;
  idempotency_key: string | null;
  state: Generated<CommandState>;
  claimed_at: number | null;
  attempts: number | null;
  result_json: string | null;
  error: string | null;
}

export interface KeyValueTable {
  key: string;
  value_json: string;
  updated_at: number;
}

export interface AuditLogTable {
  id: Generated<number>;
  ts: number;
  actor: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  payload_json: string | null;
  ip: string | null;
  /** 031: the project the row is about, stamped by insertAudit; NULL when none resolves. */
  workspace_id: string | null;
}

/** v_fleet (§4.1). `idle_ms` reads the wall clock, through unixepoch(). */
export interface FleetView {
  id: string;
  agent: string;
  role: string;
  run_class: string;
  state: SessionState;
  runner_id: string;
  executor_id: string;
  model_tier: string | null;
  ticket: number | null;
  title: string | null;
  turns: number;
  cost_usd: number;
  idle_ms: number | null;
}

export interface DB
  extends WorkDB, PulseDB, FleetDB, NotifyDB, JiraPushDB, RunnerUpdatesDB {
  runners: RunnersTable;
  executors: ExecutorsTable;
  models: ModelsTable;
  repos: ReposTable;
  workspaces: WorkspacesTable;
  workspace_repos: WorkspaceReposTable;
  worktrees: WorktreesTable;
  agents: AgentsTable;
  missions: MissionsTable;
  profiles: ProfilesTable;
  prompt_templates: PromptTemplatesTable;
  run_classes: RunClassesTable;
  sessions: SessionsTable;
  runs: RunsTable;
  events: EventsTable;
  spend: SpendTable;
  tickets: TicketsTable;
  commands: CommandsTable;
  supervisor_state: KeyValueTable;
  settings: KeyValueTable;
  audit_log: AuditLogTable;
  v_fleet: FleetView;
  runner_certifications: RunnerCertificationsTable;
  conformance_probes: ConformanceProbesTable;
}

export type AgentRow = Selectable<AgentsTable>;
export type MissionRow = Selectable<MissionsTable>;
export type ProfileRow = Selectable<ProfilesTable>;
export type RepoRow = Selectable<ReposTable>;
export type WorkspaceRow = Selectable<WorkspacesTable>;
export type WorktreeRow = Selectable<WorktreesTable>;
export type CommandRow = Selectable<CommandsTable>;
export type EventRow = Selectable<EventsTable>;
export type FleetRow = Selectable<FleetView>;
export type RunClassRow = Selectable<RunClassesTable>;
export type RunRow = Selectable<RunsTable>;
export type SessionRow = Selectable<SessionsTable>;
export type SpendRow = Selectable<SpendTable>;
export type TicketRow = Selectable<TicketsTable>;
export type RunnerRow = Selectable<RunnersTable>;
export type ModelRow = Selectable<ModelsTable>;
export type ExecutorRow = Selectable<ExecutorsTable>;
