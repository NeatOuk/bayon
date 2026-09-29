import { ConformanceSummary } from "@bayon/core";
import { z } from "zod";

// Contract 6. The API inserts one `commands` row per request; the supervisor claims it, runs the
// handler registered for its `type` (payload parsed with the schema below) and completes it.

const Id = z.string().min(1);

/** The command types, i.e. the `commands.type` values the API writes. */
export const CommandType = z.enum([
  "session.spawn",
  "session.interrupt",
  "session.stop",
  "export.run",
  // M2: contracts first; their handlers come with later tickets.
  "session.handoff",
  "pulse.run",
  "pulse.report",
  "probe.run",
  // M3: a gate the API opened; the gate engine claims it.
  "gate.run",
  // M3: the conformance suite for one (runner, executor) pair.
  "runner.conformance",
  // M3: one executor's health check (§6.1), run by the supervisor.
  "executor.health",
  // M5 (§12.5): the operator takes or releases a session's attach (terminal takeover) lease.
  "session.attach",
  "session.detach",
  // M13: whether a repo URL can be read the way the mirror clone reads it.
  "repo.check",
]);
export type CommandType = z.infer<typeof CommandType>;
export const COMMAND_TYPES = CommandType.options;

/** `commands.state`: `pending → claimed → done | failed`. */
export const CommandState = z.enum(["pending", "claimed", "done", "failed"]);
export type CommandState = z.infer<typeof CommandState>;

/** `session.spawn`. The API mints `session_id`; the supervisor creates the session row. */
export const SessionSpawnPayload = z.object({
  session_id: Id,
  agent_id: Id,
  role: Id,
  run_class: Id,
  workspace_id: Id.optional(),
  ticket_id: Id.optional(),
  runner_id: Id.optional(),
  executor_id: Id.optional(),
  /** Amendment 6: the first run's prompt, written to `prompts/run-1.md` and hashed. */
  prompt: z.string().min(1).optional(),
  /** M2: the pending hand-off this session takes over (§7.3). Staffing sets it; REST cannot. */
  handoff_id: Id.optional(),
  /** M3 trust rule: the session reads content nobody vouched for, so admission places it only on
   * a trust='untrusted' executor. */
  untrusted_input: z.boolean().optional(),
});
export type SessionSpawnPayload = z.infer<typeof SessionSpawnPayload>;

export const SessionInterruptPayload = z.object({ session_id: Id });
export type SessionInterruptPayload = z.infer<typeof SessionInterruptPayload>;

/**
 * `session.attach`/`session.detach` (§12.5). `client_token`, when the caller supplies one, becomes
 * `attach_lease_owner` verbatim instead of a server-minted one — so the caller (the GUI) can later
 * recognize its own lease on a poll by simple equality, rather than guessing which of possibly
 * several newly-non-null values is the one its own request produced. Absent, a token is minted here
 * as before (unchanged for any caller that isn't the web GUI). Not a secret: this was already just
 * an opaque correlation token, never a credential.
 */
/**
 * When an attach takes the session. `now` stops the agent where it is, mid-turn if it
 * is in one, as attach always did. `turn_end` waits for the open run's terminal and takes over
 * between turns, so no half-done turn is thrown away; on a session with no run open it is `now`.
 */
export const AttachWhen = z.enum(["now", "turn_end"]);
export type AttachWhen = z.infer<typeof AttachWhen>;

export const SessionAttachPayload = z.object({
  session_id: Id,
  client_token: z.string().min(1).max(200).optional(),
  /** Absent: `now`, so a command row stored before an earlier change still means what it meant. */
  when: AttachWhen.optional(),
});
export type SessionAttachPayload = z.infer<typeof SessionAttachPayload>;

export const SessionDetachPayload = z.object({ session_id: Id });
export type SessionDetachPayload = z.infer<typeof SessionDetachPayload>;

/** The runner's stop modes (§5 `stop(h, mode)`). */
export const StopMode = z.enum(["graceful", "kill"]);
export type StopMode = z.infer<typeof StopMode>;

export const SessionStopPayload = z.object({ session_id: Id, mode: StopMode });
export type SessionStopPayload = z.infer<typeof SessionStopPayload>;

/** `export.run`: no fields -- the supervisor decides whether to reuse the exporter's
 * live session or spawn a fresh one (`spawnExportIfIdle`). */
export const ExportRunPayload = z.object({});
export type ExportRunPayload = z.infer<typeof ExportRunPayload>;

/** Why a session hands off (§7.1): the `handoffs.reason` values. */
export const HandoffReason = z.enum([
  "context_ceiling",
  "turn_ceiling",
  "budget",
  "phase_change",
  "role_change",
  "human_release",
  "session_death",
  "operator",
  "agent_request",
  /**
   * The holder went silent past `watchdog.silent_ms` and a staffing call asked for its ticket
   * back. The server's own reason, never a human's: `session_death` is a session the
   * supervisor watched end, and this one is still `running` — it just stopped saying anything.
   */
  "stale_session",
]);
export type HandoffReason = z.infer<typeof HandoffReason>;

/**
 * `session.handoff` (§7.1): move a live session to handoff_writing. The operator's route inserts it
 * with `operator`, the handoff_request tool with `agent_request` and the agent's why as `note`, and
 * a transition that crosses a phase boundary with `phase_change` and the phase it hands on to
 *.
 */
export const SessionHandoffPayload = z.object({
  session_id: Id,
  reason: HandoffReason,
  note: z.string().min(1).max(500).optional(),
  /**
   * The run class the ticket's new status asks for: the packet's `phase_to`, so its header reads
   * `spike → build` instead of the `build → build` every packet reads today. Absent when the new
   * status asks for no class at all (a waiting room), where the next phase is not yet decided.
   */
  phase_to: z.string().min(1).max(64).optional(),
});
export type SessionHandoffPayload = z.infer<typeof SessionHandoffPayload>;

/** `pulse.run` (§9.7 manual, `POST /pulses/run-now`): one pulse now. It skips the gap, not the lease. */
export const PulseRunPayload = z.object({ agent_id: Id });
export type PulseRunPayload = z.infer<typeof PulseRunPayload>;

/**
 * `pulse.report` (§10.1): the orchestrator's summary and actions for its pulse. The API inserts it
 * from the pulse_report tool, since pulses is the supervisor's table (§9.5).
 */
export const PulseReportPayload = z.object({
  pulse_id: Id,
  session_id: Id,
  summary_md: z.string().min(1).max(4000),
  /** One line per thing the orchestrator did, e.g. "staffed #12 as builder". */
  actions: z.array(z.string().min(1).max(200)).max(20),
});
export type PulseReportPayload = z.infer<typeof PulseReportPayload>;

/** `probe.run` (§11.1): re-run one probe within a pulse; the result is a new pulse_checks row. */
export const ProbeRunPayload = z.object({
  pulse_id: Id,
  probe: z.string().min(1).max(64),
});
export type ProbeRunPayload = z.infer<typeof ProbeRunPayload>;

/**
 * `gate.run` (M3 amendment h): the API inserts it with the gate, in the transition's transaction; the
 * gate row is `running`, with no reviewer session yet. The API mints `session_id`; the gate engine
 * creates that session with `sessions.gate_id = gate_id`, or spawns nothing when the gate is no
 * longer running (waived or superseded). Its idempotency key is `gate.run:<gate_id>`.
 */
export const GateRunPayload = z.object({ gate_id: Id, session_id: Id });
export type GateRunPayload = z.infer<typeof GateRunPayload>;

/** A directory on the supervisor's host: absolute, since the supervisor has a cwd of its own. */
export const ReportDir = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^\//, "must be an absolute path");

/**
 * `runner.conformance` (§15): the conformance suite for one runner with one model
 * (`model_id`, a models row of the runner) on one executor, on the supervisor's ports.
 * The report goes to `report_dir`, else `<FRM_HOME>/conformance/`.
 */
export const RunnerConformancePayload = z.object({
  runner_id: Id,
  executor_id: Id,
  model_id: Id,
  report_dir: ReportDir.optional(),
  /** With context compression on (spec M12): test 17 too, a compression-on certificate. */
  compression: z.boolean().optional(),
});
export type RunnerConformancePayload = z.infer<typeof RunnerConformancePayload>;

/**
 * A `runner.conformance` command's result. `stored`: the result was certifiable, so it is the
 * pair's certification now; an incomplete run stores nothing and decertifies nothing. `passed_at`:
 * what the stored row's passed_at holds, set only when the pair is certified; null when
 * not, and for results written before it was reported. `teardown`: what the end of the run left
 * undone, e.g. a process still alive that had to be killed; a run with any stores
 * nothing, whatever its tests say. Empty for a clean end, and for results written before it was.
 */
export const RunnerConformanceResult = z.object({
  runner_id: Id,
  executor_id: Id,
  /** The model it ran; null for results written before certification was per model. */
  model_id: Id.nullable().default(null),
  model: z.string().nullable().default(null),
  runner_version: z.string().min(1),
  report_path: z.string().min(1),
  stored: z.boolean(),
  passed_at: z.int().nonnegative().nullable().default(null),
  summary: ConformanceSummary,
  teardown: z.array(z.string()).default([]),
  /** The run had context compression on: what it stored is the compression-on row. */
  compression: z.boolean().default(false),
});
export type RunnerConformanceResult = z.infer<typeof RunnerConformanceResult>;

/**
 * `executor.health` (§6.1): the executor's own health check, run by the supervisor, which
 * records `executors.health` and `health_detail`. `POST /executors/:id/health` inserts it.
 */
export const ExecutorHealthPayload = z.object({ executor_id: Id });
export type ExecutorHealthPayload = z.infer<typeof ExecutorHealthPayload>;

/** An `executor.health` command's result: what the check found, as recorded. */
export const ExecutorHealthResult = z.object({
  executor_id: Id,
  health: z.enum(["healthy", "unhealthy"]),
});
export type ExecutorHealthResult = z.infer<typeof ExecutorHealthResult>;

/**
 * `repo.check`: `git ls-remote` of `url`, run by the supervisor with the credential its
 * mirror clone would be offered. `base`, when given, is looked for among the remote's branches.
 * Result: core's RepoCheckResult.
 */
export const RepoCheckPayload = z.object({
  url: z.string().min(1).max(2_000),
  base: z.string().min(1).max(200).optional(),
});
export type RepoCheckPayload = z.infer<typeof RepoCheckPayload>;

/** A command as stored: `type` plus the payload that type requires. */
export const Command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(CommandType.enum["executor.health"]),
    payload: ExecutorHealthPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["gate.run"]),
    payload: GateRunPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["session.spawn"]),
    payload: SessionSpawnPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["session.interrupt"]),
    payload: SessionInterruptPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["session.stop"]),
    payload: SessionStopPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["export.run"]),
    payload: ExportRunPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["session.handoff"]),
    payload: SessionHandoffPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["pulse.run"]),
    payload: PulseRunPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["pulse.report"]),
    payload: PulseReportPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["runner.conformance"]),
    payload: RunnerConformancePayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["probe.run"]),
    payload: ProbeRunPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["session.attach"]),
    payload: SessionAttachPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["session.detach"]),
    payload: SessionDetachPayload,
  }),
  z.object({
    type: z.literal(CommandType.enum["repo.check"]),
    payload: RepoCheckPayload,
  }),
]);
export type Command = z.infer<typeof Command>;

/**
 * `POST /sessions`: the spawn payload minus `session_id`, which the API mints, and `handoff_id`,
 * which only staffing sets (M2). Unknown keys fail.
 */
export const SpawnRequest = z.strictObject(
  SessionSpawnPayload.omit({ session_id: true, handoff_id: true }).shape,
);
export type SpawnRequest = z.infer<typeof SpawnRequest>;

/** `POST /sessions/:id/stop`. No body means a graceful stop. */
export const StopRequest = z
  .strictObject({ mode: StopMode.default("graceful") })
  .prefault({});
export type StopRequest = z.infer<typeof StopRequest>;

/**
 * `POST /sessions/:id/attach`. No body means the supervisor mints the lease owner itself and takes
 * the session `now`, as before; `when: "turn_end"` waits for the open run to end.
 */
export const AttachRequest = z
  .strictObject({
    client_token: z.string().min(1).max(200).optional(),
    when: AttachWhen.default("now"),
  })
  .prefault({});
export type AttachRequest = z.infer<typeof AttachRequest>;

/** Optional on every command-inserting route; a repeat returns the first command. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IdempotencyKey = z.string().min(1).max(255);

/** The reply to every session command route. `created` is false for a repeated Idempotency-Key. */
export const CommandAccepted = z.object({
  command_id: Id,
  session_id: Id,
  created: z.boolean(),
});
export type CommandAccepted = z.infer<typeof CommandAccepted>;

/** `POST /exports/run`'s reply: no `session_id` -- the API never mints one for this command, since
 * the supervisor decides whether to reuse a live exporter session or spawn one. */
export const ExportRunAccepted = z.object({
  command_id: Id,
  created: z.boolean(),
});
export type ExportRunAccepted = z.infer<typeof ExportRunAccepted>;
