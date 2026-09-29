import type { Generated, Selectable } from "kysely";

// Hand-written Kysely types for 004_pulse: the §4 pulse tables (M2). schema-columns-pulse.ts
// restates them at runtime, and schema.test.ts checks that against PRAGMA table_info. Conventions
// as in schema.ts.

/** `pulses.trigger` (§9.7): which path fired the pulse. */
export type PulseTrigger = "cron" | "completion" | "manual" | "catchup";

/**
 * `pulses.state`. `leased` and `running` hold the agent's single-flight lease (amendment d);
 * `skipped` carries a skip_reason, and `expired` is a lease the reconciler timed out.
 */
export type PulseState =
  "leased" | "running" | "done" | "skipped" | "failed" | "expired";

export interface PulsesTable {
  id: string;
  agent_id: string;
  trigger: PulseTrigger;
  scheduled_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  state: PulseState;
  skip_reason: string | null;
  session_id: string | null;
  run_id: string | null;
  context_pack_path: string | null;
  context_tokens: number | null;
  summary_md: string | null;
  actions_json: string | null;
  cost_usd: number | null;
  started_at: number | null;
  ended_at: number | null;
}

/** `probes.kind` (§10.2). M2 runs sql and shell; the other two are refused until later. */
export type ProbeKind = "sql" | "shell" | "http" | "script_runner";

export interface ProbesTable {
  name: string;
  kind: ProbeKind;
  /** sql: `{query}` names a query in packages/db; shell: `{argv, cwd}` (004_pulse.sql). */
  spec_json: string;
  timeout_ms: Generated<number>;
  enabled: Generated<number>;
  untrusted_output: Generated<number>;
  every_pulse: Generated<number>;
}

/** `pulse_checks.state`: how one probe run ended. Its findings are in result_json either way. */
export type PulseCheckState = "ok" | "error" | "timeout";

export interface PulseChecksTable {
  id: string;
  pulse_id: string;
  name: string;
  state: PulseCheckState;
  duration_ms: number | null;
  result_json: string | null;
  result_path: string | null;
  error: string | null;
}

export interface PulseDB {
  pulses: PulsesTable;
  probes: ProbesTable;
  pulse_checks: PulseChecksTable;
}

export type PulseRow = Selectable<PulsesTable>;
export type ProbeRow = Selectable<ProbesTable>;
export type PulseCheckRow = Selectable<PulseChecksTable>;
