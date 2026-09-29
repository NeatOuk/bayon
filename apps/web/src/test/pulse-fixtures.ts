import type {
  AgentPulse,
  PulseCheckView,
  PulseDetail,
  PulseView,
} from "@bayon/proto";

// Wire-shaped pulse data (DTOs): every value here would pass its proto schema.

export const T0 = 1_800_000_000_000;

export const pulseView = (
  pulse: Partial<PulseView> & Pick<PulseView, "id">,
): PulseView => ({
  agent_id: "orch-1",
  trigger: "cron",
  scheduled_at: T0,
  state: "done",
  skip_reason: null,
  session_id: null,
  run_id: null,
  context_pack_path: null,
  context_tokens: null,
  summary_md: null,
  actions: null,
  cost_usd: null,
  started_at: null,
  ended_at: null,
  ...pulse,
});

export const pulseCheck = (
  check: Partial<PulseCheckView> & Pick<PulseCheckView, "name">,
): PulseCheckView => ({
  id: `check-${check.name}`,
  state: "ok",
  duration_ms: 3,
  result: { untrusted: false, rows: [] },
  result_path: null,
  error: null,
  ...check,
});

export const pulseDetail = (
  pulse: PulseView,
  checks: readonly PulseCheckView[] = [],
): PulseDetail => ({ ...pulse, checks: [...checks] });

export const agentPulse = (
  agent: Partial<AgentPulse> & Pick<AgentPulse, "agent_id">,
): AgentPulse => ({
  name: agent.agent_id,
  mode: "hybrid",
  interval_ms: 5_400_000,
  debounce_ms: 60_000,
  min_gap_ms: 300_000,
  max_per_hour: 8,
  jitter_pct: 5,
  next_pulse_at: null,
  ...agent,
});
