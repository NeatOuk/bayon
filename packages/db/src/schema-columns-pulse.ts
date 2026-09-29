import type { ColumnMap } from "./schema-columns.js";
import type { PulseDB } from "./schema-pulse.js";

// 004_pulse's part of COLUMNS (schema-columns.ts): the same column specs, restated for its tables.
const text = { type: "TEXT", notnull: true } as const;
const textNull = { type: "TEXT", notnull: false } as const;
const int = { type: "INTEGER", notnull: true } as const;
const intNull = { type: "INTEGER", notnull: false } as const;
const realNull = { type: "REAL", notnull: false } as const;
const id = { ...text, pk: 1 } as const;

export const PULSE_COLUMNS: Pick<ColumnMap, keyof PulseDB> = {
  pulses: {
    id,
    agent_id: text,
    trigger: text,
    scheduled_at: int,
    lease_token: textNull,
    lease_expires_at: intNull,
    state: text,
    skip_reason: textNull,
    session_id: textNull,
    run_id: textNull,
    context_pack_path: textNull,
    context_tokens: intNull,
    summary_md: textNull,
    actions_json: textNull,
    cost_usd: realNull,
    started_at: intNull,
    ended_at: intNull,
  },
  probes: {
    name: id,
    kind: text,
    spec_json: text,
    timeout_ms: int,
    enabled: int,
    untrusted_output: int,
    every_pulse: int,
  },
  pulse_checks: {
    id,
    pulse_id: text,
    name: text,
    state: text,
    duration_ms: intNull,
    result_json: textNull,
    result_path: textNull,
    error: textNull,
  },
};
