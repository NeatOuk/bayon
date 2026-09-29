import {
  AdmissionGate,
  BudgetOnBreach,
  BudgetPeriod,
  BudgetScope,
  CanonicalEvent,
  ErrorClass,
  EventKind,
  ExitReason,
  FrmError,
  QueuedReason,
  RefusalReason,
  SessionState,
} from "@bayon/core";
import { z } from "zod";
import { CommandState } from "./commands.js";

// REST DTOs for /api/v1 (§12.1). A NULL column is `null` here; only canonical events drop them.

const count = z.int().nonnegative();
const epochMs = z.int().nonnegative();
const nullableText = z.string().nullable();

/** `GET /health`, the one route without a bearer. */
export const Health = z.object({ status: z.literal("ok") });
export type Health = z.infer<typeof Health>;

/**
 * One `v_fleet` row (§4.1), with its project and its ticket's key. `agent` is the
 * agent's name, which is unique fleet-wide.
 */
export const FleetRow = z.object({
  id: z.string(),
  agent: z.string(),
  role: z.string(),
  run_class: z.string(),
  state: SessionState,
  runner_id: z.string(),
  executor_id: z.string(),
  model_tier: nullableText,
  ticket: z.int().nullable(),
  title: nullableText,
  turns: count,
  cost_usd: z.number(),
  idle_ms: z.int().nullable(),
  /** The project: the session's own workspace, else its agent's; null for fleet work. */
  workspace_id: nullableText,
  /** `<prefix><num>` of `ticket`; null when it has none. */
  ticket_key: nullableText,
});
export type FleetRow = z.infer<typeof FleetRow>;

/**
 * `GET /fleet?project=<workspace id>`: only that project's sessions. Budget, slots,
 * attention, disk, admission and backup stay fleet-wide, so the body is still a `Fleet`.
 */
export const FleetQuery = z.object({
  project: z.string().min(1).max(64).optional(),
});
export type FleetQuery = z.infer<typeof FleetQuery>;

/** Amendment 8: spend since the start of the UTC day against `settings.budget.daily_cap_usd` (null: no cap). */
export const FleetBudget = z.object({
  today_usd: z.number().nonnegative(),
  daily_cap_usd: z.number().nonnegative().nullable(),
});
export type FleetBudget = z.infer<typeof FleetBudget>;

/** `GET/PUT /settings/budget` (§12.1): the operator-set daily cap; null means no cap. */
export const BudgetSettings = z.object({
  daily_cap_usd: z.number().nonnegative().nullable(),
});
export type BudgetSettings = z.infer<typeof BudgetSettings>;

/**
 * One budget (§4, §13.4) with what it has spent in the window holding now. The window and both
 * `spent_` values are computed at read time from `spend`, never stored, so a window rolls by
 * itself and a breach lifts on its own.
 */
export const BudgetView = z.object({
  id: z.string(),
  scope: BudgetScope,
  /** The agent of an agent budget; null for the fleet. */
  scope_ref: nullableText,
  period: BudgetPeriod,
  cap_usd: z.number().nonnegative().nullable(),
  /** Caps tokens_in + tokens_out. */
  cap_tokens: count.nullable(),
  warn_pct: z.int().min(1).max(100),
  on_breach: BudgetOnBreach,
  updated_at: epochMs,
  window_start: epochMs,
  window_end: epochMs,
  spent_usd: z.number().nonnegative(),
  spent_tokens: count,
});
export type BudgetView = z.infer<typeof BudgetView>;

/** `GET /budgets` (§12.1). */
export const BudgetsView = z.object({ budgets: z.array(BudgetView) });
export type BudgetsView = z.infer<typeof BudgetsView>;

/**
 * `PUT /budgets` (§12.1): one budget per scope and period, replaced whole. `on_breach: 'kill'` is
 * refused here by `BudgetOnBreach` having no such value — §13.4's kill is deferred past M4 — and
 * again by a CHECK in 012_fleet.
 */
export const PutBudget = z.object({
  scope: BudgetScope,
  /** An agent budget names its agent; a fleet budget names none. */
  scope_ref: z.string().min(1).nullish(),
  period: BudgetPeriod,
  cap_usd: z.number().nonnegative().nullish(),
  cap_tokens: count.nullish(),
  /** Omitted: the column default, 70. */
  warn_pct: z.int().min(1).max(100).optional(),
  /** Omitted: the column default, pause_admission. */
  on_breach: BudgetOnBreach.optional(),
});
export type PutBudget = z.infer<typeof PutBudget>;

/** Live sessions on one executor, against its `executors.slots`. */
export const ExecutorSlots = z.object({
  executor_id: z.string(),
  busy: count,
  capacity: count,
});
export type ExecutorSlots = z.infer<typeof ExecutorSlots>;

/** An enabled executor's free disk as its last health check measured it (§6.1, M4 §12.1). */
export const ExecutorDisk = z.object({
  executor_id: z.string(),
  /** The lowest free % over the paths it measured; null when it measured none. */
  free_pct: z.number().min(0).max(100).nullable(),
  /** The floor that check judged against. */
  min_free_pct: z.number().min(0).max(100).nullable(),
  checked_at: epochMs.nullable(),
});
export type ExecutorDisk = z.infer<typeof ExecutorDisk>;

/**
 * Amendment 8, computed by the server. `stale`: running or idle with no event for 30 min, `since`
 * its last event. `errored`: an error exit in the last 24 h, `since` the exit, `detail` its message.
 */
export const AttentionItem = z.object({
  session_id: z.string(),
  agent: z.string(),
  why: z.enum(["stale", "errored"]),
  since: epochMs,
  detail: nullableText,
});
export type AttentionItem = z.infer<typeof AttentionItem>;

/** A pending session admission holds, and the gate holding it. */
export const QueuedSession = z.object({
  session_id: z.string(),
  agent: z.string(),
  executor_id: z.string(),
  reason: QueuedReason,
  /** Pending since: the session's created_at. */
  since: epochMs,
});
export type QueuedSession = z.infer<typeof QueuedSession>;

/** `GET /fleet`'s admission block: queued sessions, oldest first, and a count by reason. */
export const FleetAdmission = z.object({
  queued: z.array(QueuedSession),
  by_reason: z.partialRecord(QueuedReason, count),
});
export type FleetAdmission = z.infer<typeof FleetAdmission>;

/** A finished backup attempt (§13.2): an ok one names its encrypted file, a failed one says why. */
export const BackupAttempt = z.object({
  outcome: z.enum(["ok", "failed"]),
  started_at: epochMs,
  ended_at: epochMs,
  path: nullableText,
  error: nullableText,
});
export type BackupAttempt = z.infer<typeof BackupAttempt>;

/** `GET /fleet`'s backup block (M4 §12.1): the newest attempt, and when one last succeeded. */
export const FleetBackup = z.object({
  last: BackupAttempt.nullable(),
  last_ok_at: epochMs.nullable(),
});
export type FleetBackup = z.infer<typeof FleetBackup>;

/**
 * An open runner update check: a runner's own package is newer on npm than what is
 * installed, not yet dismissed. Nothing here ever upgrades anything.
 */
export const RunnerUpdateView = z.object({
  runner_id: z.string(),
  current: z.string(),
  latest: z.string(),
  notes_url: nullableText,
  found_at: epochMs,
});
export type RunnerUpdateView = z.infer<typeof RunnerUpdateView>;

/** `GET /fleet`, and the `data` of every `fleet` WS frame. */
export const Fleet = z.object({
  /** `fleet.paused`: the kill switch (M4 §13.3), so the GUI's header shows it live. */
  paused: z.boolean(),
  sessions: z.array(FleetRow),
  /** Amendment 8's daily cap, which the bar still reads; `budgets` is §13.4's full set. */
  budget: FleetBudget,
  budgets: z.array(BudgetView),
  slots: z.array(ExecutorSlots),
  attention: z.array(AttentionItem),
  disk: z.array(ExecutorDisk),
  admission: FleetAdmission,
  backup: FleetBackup,
  runner_updates: z.array(RunnerUpdateView),
});
export type Fleet = z.infer<typeof Fleet>;

/**
 * A session's context compression totals over its runs (spec M12): blocks over §8.5's
 * cap seen, compressed and failed open (sent whole), and their characters before and after.
 */
export const SessionContextView = z.object({
  ruleset: z.string(),
  runs: count,
  calls: count,
  blocks: count,
  compressed: count,
  failed: count,
  chars_in: count,
  chars_out: count,
});
export type SessionContextView = z.infer<typeof SessionContextView>;

/** `GET /sessions/:id`: the `sessions` row minus `mcp_token_hash`, which never leaves the DB. */
export const SessionView = z.object({
  id: z.string(),
  agent_id: z.string(),
  /** `agents.name`, the key of `/missions/:agent` (the GUI's "add a law" link). */
  agent_name: z.string(),
  ticket_id: nullableText,
  role: z.string(),
  run_class: z.string(),
  runner_id: z.string(),
  runner_version: nullableText,
  runner_session_id: nullableText,
  executor_id: z.string(),
  executor_ref: nullableText,
  model: nullableText,
  model_tier: nullableText,
  effort: nullableText,
  workspace_id: nullableText,
  session_root: z.string(),
  home_dir: z.string(),
  config_hash: z.string(),
  mission_hash: nullableText,
  doctrine_hash: nullableText,
  toolset_hash: nullableText,
  state: SessionState,
  predecessor_session_id: nullableText,
  handoff_in_id: nullableText,
  handoff_out_id: nullableText,
  raw_log_path: z.string(),
  pty_log_path: nullableText,
  tmux_target: nullableText,
  attach_lease_owner: nullableText,
  attach_lease_expires_at: epochMs.nullable(),
  /** A pending "take over after this step": the lease owner it will mint, and when. */
  attach_intent_owner: nullableText,
  attach_intent_at: epochMs.nullable(),
  turns: count,
  tool_calls: count,
  cost_usd: z.number(),
  cost_source: z.enum(["reported", "estimated"]),
  tokens_in: count.nullable(),
  tokens_out: count.nullable(),
  tokens_cache_read: count.nullable(),
  tokens_cache_write: count.nullable(),
  context_peak_tokens: count.nullable(),
  last_event_at: epochMs.nullable(),
  started_at: epochMs.nullable(),
  ended_at: epochMs.nullable(),
  exit_reason: ExitReason.nullable(),
  error_class: ErrorClass.nullable(),
  error_message: nullableText,
  created_at: epochMs,
  raw_segment_offset: count.nullable(),
  /** The context ruleset it was spawned with (spec M12); null: not compressed. */
  context_ruleset: nullableText.default(null),
  /** Its estimated saving from context compression (chars/4); null until a proxied run reports. */
  tokens_saved: count.nullable().default(null),
  /** Its runs' context totals, summed; null when no run reported any. */
  context: SessionContextView.nullable().default(null),
});
export type SessionView = z.infer<typeof SessionView>;

/** What an `events` row adds to its canonical event: the cursor id and the §8.5 truncation facts. */
export const EventMeta = z.object({
  id: z.int().positive(),
  truncated: z.boolean().optional(),
  bytes_original: count.optional(),
  payload_path: z.string().optional(),
});

/** One stored canonical event, as REST pages and WS `events` frames carry it. */
export const EventItem = z.intersection(CanonicalEvent, EventMeta);
export type EventItem = z.infer<typeof EventItem>;

export const EVENTS_PAGE_DEFAULT_LIMIT = 200;
export const EVENTS_PAGE_MAX_LIMIT = 1_000;

const queryInt = z.coerce.number().pipe(z.int().nonnegative());
const kindList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    [value]
      .flat()
      .flatMap((part) => part.split(","))
      .filter((kind) => kind !== ""),
  )
  .pipe(z.array(EventKind).min(1));

/** `GET /sessions/:id/events?since=&kind=&limit=`. `since` is an exclusive `events.id`. */
export const EventsQuery = z.object({
  since: queryInt.default(0),
  kind: kindList.optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(EVENTS_PAGE_MAX_LIMIT))
    .default(EVENTS_PAGE_DEFAULT_LIMIT),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

/** A page of events. Ask again with `since = next_cursor` while `has_more`. */
export const EventsPage = z.object({
  items: z.array(EventItem),
  next_cursor: count,
  has_more: z.boolean(),
});
export type EventsPage = z.infer<typeof EventsPage>;

/**
 * The wire form of an `FrmError`: `cause` stays in the server log. A 409 from a stale
 * compare-and-set also names the version now current (M1 contract 3), so a client can refetch.
 */
export const WireError = FrmError.omit({ cause: true }).extend({
  current_version: count.optional(),
  /** A 422 `law_refused` (M1 contract 2): the rule that refused, why, and the detail. */
  rule: z.string().optional(),
  reason: RefusalReason.optional(),
  detail: z.string().optional(),
  /** A 429 `admission_refused`: the admission gate that refused. */
  gate: AdmissionGate.optional(),
});
export type WireError = z.infer<typeof WireError>;

/**
 * An unsettled command the claimer takes before another of the same type, as `GET /commands/:id`
 * reports it. It is a fact about the queue, not a claim that it blocks: whether a type
 * runs one at a time is its supervisor handler's business (`runner.conformance` does, §15).
 */
export const QueuedCommand = z.object({
  id: z.string(),
  ts: epochMs,
  state: CommandState.extract(["pending", "claimed"]),
  claimed_at: epochMs.nullable(),
  payload: z.unknown(),
});
export type QueuedCommand = z.infer<typeof QueuedCommand>;

/** `GET /commands/:id`. */
export const CommandView = z.object({
  id: z.string(),
  ts: epochMs,
  type: z.string(),
  payload: z.unknown(),
  state: CommandState,
  idempotency_key: nullableText,
  claimed_at: epochMs.nullable(),
  attempts: count,
  result: z.unknown(),
  error: WireError.nullable(),
  /**
   * The server's clock when the row was read. How long a command has been queued is
   * `now - ts` and how long it has run is `now - claimed_at`, so neither is measured against the
   * reader's own clock.
   */
  now: epochMs,
  /**
   * The unsettled commands of the same type the claimer takes before this one, in that order:
   * `ts`, then `id`. Not the order they were posted in — two minted in the same millisecond are
   * ordered by id alone. Empty once this one is at the head of its type's queue, and always for a
   * settled command.
   */
  ahead: z.array(QueuedCommand),
});
export type CommandView = z.infer<typeof CommandView>;

/** Every non-2xx response body. */
export const ApiErrorBody = z.object({ error: WireError });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
