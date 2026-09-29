import {
  PulsePolicy as SchedulePolicy,
  nextWake,
  ok,
  type Result,
} from "@bayon/core";
import {
  getAgent,
  getPulse,
  listPulseAgents,
  listPulseChecks,
  listPulses,
  pulseHistory,
  type AgentRow,
  type Db,
  type PulseCheckRow,
  type PulseRow,
} from "@bayon/db";
import { setPulsePolicy } from "@bayon/db/api";
import {
  AgentPulse,
  PULSES_TOPIC_LIMIT,
  PulseCheckView,
  PulseDetail,
  PulsePolicy,
  PulseView,
} from "@bayon/proto";
import { jsonColumn, parseAs } from "./dto.js";
import type { ApiStore } from "./store.js";

// The pulse half of the ApiStore (M2): the supervisor's pulses and pulse_checks as DTOs, the
// agents' kind for run-now, and the pulse policy, the one agents write the API makes (audited).

export type PulseStore = Pick<
  ApiStore,
  | "pulses"
  | "recentPulses"
  | "pulse"
  | "agentKind"
  | "setPulsePolicy"
  | "pulseAgents"
>;

function toPulseView(row: PulseRow): Result<PulseView> {
  const actions = jsonColumn(row.actions_json, `pulse ${row.id} actions`);
  if (!actions.ok) return actions;
  return parseAs(
    PulseView,
    {
      id: row.id,
      agent_id: row.agent_id,
      trigger: row.trigger,
      scheduled_at: row.scheduled_at,
      state: row.state,
      skip_reason: row.skip_reason,
      session_id: row.session_id,
      run_id: row.run_id,
      context_pack_path: row.context_pack_path,
      context_tokens: row.context_tokens,
      summary_md: row.summary_md,
      actions: actions.value,
      cost_usd: row.cost_usd,
      started_at: row.started_at,
      ended_at: row.ended_at,
    },
    `pulse ${row.id}`,
  );
}

function toCheckView(row: PulseCheckRow): Result<PulseCheckView> {
  const result = jsonColumn(row.result_json, `pulse check ${row.id} result`);
  if (!result.ok) return result;
  return parseAs(
    PulseCheckView,
    {
      id: row.id,
      name: row.name,
      state: row.state,
      duration_ms: row.duration_ms,
      result: result.value,
      result_path: row.result_path,
      error: row.error,
    },
    `pulse check ${row.id}`,
  );
}

const toPolicy = (a: AgentRow): Result<PulsePolicy> =>
  parseAs(
    PulsePolicy,
    {
      agent_id: a.id,
      mode: a.pulse_mode,
      interval_ms: a.pulse_interval_ms,
      debounce_ms: a.pulse_debounce_ms,
      min_gap_ms: a.pulse_min_gap_ms,
      max_per_hour: a.pulse_max_per_hour,
      jitter_pct: a.pulse_jitter_pct,
    },
    `pulse policy of agent ${a.id}`,
  );

/**
 * The agent's policy, and its next wake by the scheduler's own rule (core nextWake over its pulse
 * history) without the completions only the supervisor holds. A policy the scheduler would refuse
 * arms no wake there, so none here either.
 */
async function toAgentPulse(
  db: Db,
  agent: AgentRow,
  now: number,
): Promise<Result<AgentPulse>> {
  const policy = toPolicy(agent);
  if (!policy.ok) return policy;
  const history = await pulseHistory(db, agent.id, now);
  if (!history.ok) return history;
  const schedule = SchedulePolicy.safeParse({
    mode: agent.pulse_mode,
    intervalMs: agent.pulse_interval_ms,
    debounceMs: agent.pulse_debounce_ms,
    minGapMs: agent.pulse_min_gap_ms,
    maxPerHour: agent.pulse_max_per_hour,
    jitterPct: agent.pulse_jitter_pct,
    createdAt: agent.created_at,
  });
  const wake = schedule.success
    ? nextWake(schedule.data, history.value, null, now)
    : null;
  return parseAs(
    AgentPulse,
    { ...policy.value, name: agent.name, next_pulse_at: wake?.at ?? null },
    `pulse agent ${agent.id}`,
  );
}

/** Every row as its view, or the first one that does not fit. */
function viewsOf<Row, View>(
  rows: readonly Row[],
  view: (row: Row) => Result<View>,
): Result<View[]> {
  const views: View[] = [];
  for (const row of rows) {
    const one = view(row);
    if (!one.ok) return one;
    views.push(one.value);
  }
  return ok(views);
}

export function pulseStore(db: Db): PulseStore {
  const pulses: PulseStore["pulses"] = async ({ agentId, limit }) => {
    const rows = await listPulses(db, {
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      limit,
    });
    if (!rows.ok) return rows;
    const items = viewsOf(rows.value, toPulseView);
    return items.ok ? ok({ items: items.value }) : items;
  };
  return {
    pulses,
    recentPulses: () => pulses({ limit: PULSES_TOPIC_LIMIT }),
    async pulse(id) {
      const row = await getPulse(db, id);
      if (!row.ok) return row;
      const checks = await listPulseChecks(db, id);
      if (!checks.ok) return checks;
      const view = toPulseView(row.value);
      if (!view.ok) return view;
      const checkViews = viewsOf(checks.value, toCheckView);
      if (!checkViews.ok) return checkViews;
      return parseAs(
        PulseDetail,
        { ...view.value, checks: checkViews.value },
        `pulse ${id}`,
      );
    },
    async agentKind(id) {
      const agent = await getAgent(db, id);
      return agent.ok ? ok(agent.value.kind) : agent;
    },
    async setPulsePolicy(agentId, patch) {
      const changed = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      const row = await setPulsePolicy(db, agentId, patch, {
        actor: "operator",
        action: "rest.pulse_policy",
        target_kind: "agent",
        target_id: agentId,
        payload: changed,
      });
      return row.ok ? toPolicy(row.value) : row;
    },
    async pulseAgents(now) {
      const agents = await listPulseAgents(db);
      if (!agents.ok) return agents;
      const items: AgentPulse[] = [];
      for (const agent of agents.value) {
        const one = await toAgentPulse(db, agent, now);
        if (!one.ok) return one;
        items.push(one.value);
      }
      return ok({ items });
    },
  };
}
