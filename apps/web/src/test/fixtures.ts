import { renderMission } from "@bayon/core";
import type {
  BudgetView,
  EventItem,
  Fleet,
  FleetRow,
  MissionVersion,
  MissionView,
  SessionView,
} from "@bayon/proto";

// Wire-shaped test data: every value here would pass the proto schema it is typed with.

const T0 = 1_800_000_000_000;

const envelope = (id: number) => ({
  id,
  ts: T0 + id * 1_000,
  runner_type: "fixture.line",
  run_id: "run-1",
});

export const text = (id: number, body = `text ${id}`): EventItem => ({
  ...envelope(id),
  kind: "assistant_text",
  text: body,
  payload: {},
});

export const reasoning = (id: number, body: string): EventItem => ({
  ...envelope(id),
  kind: "reasoning",
  text: body,
  payload: {},
});

export const toolCall = (id: number, tool = "shell"): EventItem => ({
  ...envelope(id),
  kind: "tool_call",
  tool_name: tool,
  payload: { call_id: `c${id}`, input: { cmd: "pnpm test" } },
});

export const toolResult = (
  id: number,
  status: "ok" | "error",
  exitCode?: number,
): EventItem => ({
  ...envelope(id),
  kind: "tool_result",
  tool_name: "shell",
  status,
  ...(exitCode === undefined ? {} : { exit_code: exitCode }),
  payload: { call_id: `c${id}`, head: `head ${id}` },
});

export const command = (id: number, exitCode: number): EventItem => ({
  ...envelope(id),
  kind: "command",
  exit_code: exitCode,
  payload: { argv: ["pnpm", "test"], duration_ms: 1_250 },
});

export const fileChange = (id: number, path: string): EventItem => ({
  ...envelope(id),
  kind: "file_change",
  payload: { path, change: "modify", lines_added: 18, lines_removed: 4 },
});

export const error = (id: number, message: string): EventItem => ({
  ...envelope(id),
  kind: "error",
  text: message,
  payload: { class: "runner_error", message, retryable: false },
});

export const terminal = (
  id: number,
  outcome: "ok" | "failed" | "timeout",
): EventItem => ({ ...envelope(id), kind: "terminal", payload: { outcome } });

export const turnStart = (id: number): EventItem => ({
  ...envelope(id),
  kind: "turn_start",
  payload: {},
});

export const texts = (count: number): EventItem[] =>
  Array.from({ length: count }, (_, i) => text(i + 1));

export const fleetRow = (
  row: Partial<FleetRow> & Pick<FleetRow, "id">,
): FleetRow => ({
  agent: "builder-1",
  role: "build",
  run_class: "build",
  state: "running",
  runner_id: "runner-a",
  executor_id: "local",
  model_tier: null,
  ticket: null,
  title: null,
  turns: 0,
  cost_usd: 0,
  idle_ms: 0,
  workspace_id: null,
  ticket_key: null,
  ...row,
});

/** A fleet/day budget with a $100 cap, nothing spent; override whatever the test is about. */
export const budgetView = (row: Partial<BudgetView> = {}): BudgetView => ({
  id: "01J0BUDGET000000000000000",
  scope: "fleet",
  scope_ref: null,
  period: "day",
  cap_usd: 100,
  cap_tokens: null,
  warn_pct: 70,
  on_breach: "pause_admission",
  updated_at: T0,
  window_start: T0,
  window_end: T0 + 86_400_000,
  spent_usd: 0,
  spent_tokens: 0,
  ...row,
});

export const fleet = (
  sessions: readonly FleetRow[],
  rest: Partial<Omit<Fleet, "sessions">> = {},
): Fleet => ({
  paused: false,
  sessions: [...sessions],
  budget: { today_usd: 0, daily_cap_usd: null },
  budgets: [],
  slots: [],
  attention: [],
  disk: [],
  admission: { queued: [], by_reason: {} },
  backup: { last: null, last_ok_at: null },
  runner_updates: [],
  ...rest,
});

export const sessionView = (
  view: Partial<SessionView> & Pick<SessionView, "id">,
): SessionView => ({
  agent_id: "agent-1",
  agent_name: "builder-1",
  ticket_id: null,
  role: "build",
  run_class: "build",
  runner_id: "runner-a",
  runner_version: null,
  runner_session_id: null,
  executor_id: "local",
  executor_ref: null,
  model: "model-a",
  model_tier: null,
  effort: null,
  workspace_id: null,
  session_root: "/frm/runtime/sessions/s",
  home_dir: "/frm/runtime/sessions/s/home",
  config_hash: "config",
  mission_hash: null,
  doctrine_hash: null,
  toolset_hash: null,
  state: "running",
  predecessor_session_id: null,
  handoff_in_id: null,
  handoff_out_id: null,
  raw_log_path: "/frm/runtime/sessions/s/logs/stdout.jsonl",
  pty_log_path: null,
  tmux_target: null,
  attach_lease_owner: null,
  attach_lease_expires_at: null,
  attach_intent_owner: null,
  attach_intent_at: null,
  turns: 0,
  tool_calls: 0,
  cost_usd: 0,
  cost_source: "reported",
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  context_peak_tokens: null,
  last_event_at: null,
  started_at: T0,
  ended_at: null,
  exit_reason: null,
  error_class: null,
  error_message: null,
  created_at: T0,
  raw_segment_offset: null,
  context_ruleset: null,
  tokens_saved: null,
  context: null,
  ...view,
});

export const missionVersion = (
  version: Partial<MissionVersion> & Pick<MissionVersion, "version">,
): MissionVersion => {
  const row = {
    id: `mission-${version.version}`,
    hash: `hash-${version.version}`,
    note: `note ${version.version}`,
    created_at: T0 + version.version * 60_000,
    created_by: "operator",
    agent_name: "builder-1",
    who_md: "A builder.",
    what_md: "Builds tickets.",
    how_md: "Small commits.",
    laws_md: "- tests first",
    ...version,
  };
  return { ...row, rendered_md: renderMission(row.agent_name, row) };
};

/** `GET /missions/:agent` over `versions`, newest first. */
export const missionView = (
  versions: readonly MissionVersion[],
  agent = "builder-1",
): MissionView => ({
  agent,
  latest: versions[0] ?? null,
  versions: versions.map(
    ({ id, version, hash, note, created_at, created_by }) => ({
      id,
      version,
      hash,
      note,
      created_at,
      created_by,
    }),
  ),
});
