import { z } from "zod";

// Pulses (§9.7, §10.1) over REST (§12.1: GET /pulses, GET /pulses/:id, POST /pulses/run-now,
// PATCH /agents/:id/pulse-policy) and the `pulses` WS topic (§12.2). pulses and pulse_checks are the
// supervisor's tables; the API reads them, inserts `pulse.run`, and writes the agents' policy.

const Id = z.string().min(1);
const epochMs = z.int();
const count = z.int().nonnegative();
const nullableText = z.string().nullable();

export const PulseTrigger = z.enum(["cron", "completion", "manual", "catchup"]);
export type PulseTrigger = z.infer<typeof PulseTrigger>;

export const PulseState = z.enum([
  "leased",
  "running",
  "done",
  "skipped",
  "failed",
  "expired",
]);
export type PulseState = z.infer<typeof PulseState>;

/** One pulse; `actions` is the orchestrator's pulse_report list, null until it reports. */
export const PulseView = z.object({
  id: Id,
  agent_id: Id,
  trigger: PulseTrigger,
  scheduled_at: epochMs,
  state: PulseState,
  skip_reason: nullableText,
  session_id: nullableText,
  run_id: nullableText,
  context_pack_path: nullableText,
  context_tokens: count.nullable(),
  summary_md: nullableText,
  actions: z.array(z.string()).nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  started_at: epochMs.nullable(),
  ended_at: epochMs.nullable(),
});
export type PulseView = z.infer<typeof PulseView>;

/** One probe run of a pulse; `result` is its parsed result_json (full output at result_path). */
export const PulseCheckView = z.object({
  id: Id,
  name: z.string(),
  state: z.enum(["ok", "error", "timeout"]),
  duration_ms: count.nullable(),
  result: z.unknown(),
  result_path: nullableText,
  error: nullableText,
});
export type PulseCheckView = z.infer<typeof PulseCheckView>;

/** `GET /pulses/:id`: the pulse and its checks, oldest first. */
export const PulseDetail = PulseView.extend({
  checks: z.array(PulseCheckView),
});
export type PulseDetail = z.infer<typeof PulseDetail>;

export const PULSES_PAGE_DEFAULT_LIMIT = 50;
export const PULSES_PAGE_MAX_LIMIT = 200;
/** What a `pulses` frame carries: the newest pulses of every agent. */
export const PULSES_TOPIC_LIMIT = 20;

/** `GET /pulses?agent=&limit=`: newest first; `agent` is an agent id. */
export const PulsesQuery = z.object({
  agent: z.string().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(PULSES_PAGE_MAX_LIMIT))
    .default(PULSES_PAGE_DEFAULT_LIMIT),
});
export type PulsesQuery = z.infer<typeof PulsesQuery>;

/** A list of pulses, newest first: `GET /pulses` and every `pulses` frame. */
export const PulsesPage = z.object({ items: z.array(PulseView) });
export type PulsesPage = z.infer<typeof PulsesPage>;

/** `POST /pulses/run-now`: one pulse of this orchestrator now (§9.7 manual). */
export const PulseRunRequest = z.strictObject({ agent_id: Id.max(64) });
export type PulseRunRequest = z.infer<typeof PulseRunRequest>;

/** `POST /pulses/run-now`'s reply: the pulse.run command; `created` is false for a repeated key. */
export const PulseRunAccepted = z.object({
  command_id: Id,
  created: z.boolean(),
});
export type PulseRunAccepted = z.infer<typeof PulseRunAccepted>;

export const PulseMode = z.enum(["interval", "on_idle", "hybrid", "manual"]);
export type PulseMode = z.infer<typeof PulseMode>;

/** An agent's pulse policy as stored (§4 `agents.pulse_*`). */
export const PulsePolicy = z.object({
  agent_id: Id,
  mode: PulseMode,
  interval_ms: count,
  debounce_ms: count,
  min_gap_ms: count,
  max_per_hour: count,
  jitter_pct: count,
});
export type PulsePolicy = z.infer<typeof PulsePolicy>;

/**
 * `GET /agents/pulse-policies`: an agent that pulses (an enabled orchestrator), its policy and its
 * next scheduled pulse, core's nextWake over its pulse history. Completions wake on_idle and hybrid
 * agents sooner, and only the supervisor holds those, so null means "only a completion wakes it"
 * (on_idle) or "never" (manual).
 */
export const AgentPulse = PulsePolicy.extend({
  name: z.string(),
  next_pulse_at: epochMs.nullable(),
});
export type AgentPulse = z.infer<typeof AgentPulse>;

export const AgentPulsesPage = z.object({ items: z.array(AgentPulse) });
export type AgentPulsesPage = z.infer<typeof AgentPulsesPage>;

const SECOND = 1_000;
const HOUR = 3_600 * SECOND;
const DAY = 24 * HOUR;

/** `PATCH /agents/:id/pulse-policy`: any of the fields, at least one; unknown keys fail. */
export const PulsePolicyPatch = z
  .strictObject({
    mode: PulseMode.optional(),
    interval_ms: z
      .int()
      .min(SECOND)
      .max(7 * DAY)
      .optional(),
    debounce_ms: z.int().min(0).max(HOUR).optional(),
    min_gap_ms: z.int().min(0).max(DAY).optional(),
    max_per_hour: z.int().min(1).max(60).optional(),
    jitter_pct: z.int().min(0).max(50).optional(),
  })
  .refine(
    (p) => Object.values(p).some((v) => v !== undefined),
    "set at least one pulse policy field",
  );
export type PulsePolicyPatch = z.infer<typeof PulsePolicyPatch>;
