// The circuit breaker's verdict: pure over the ticket's failures since its
// reset and the retry-storm holds of the pairs they ran on. packages/db's reads apply the same
// closed lists below, so the SQL and this function cannot disagree about what a failure is.
import { inStormHold, type StormHold } from "../admission.js";
import { pairKey } from "./requests.js";

/** Run states that are failures (§5.1); interrupted and budget_stop never are. */
export const CIRCUIT_RUN_STATES = ["failed", "timeout"] as const;

/** Classes that are never the ticket's: a restart, an interruption, an admission refusal. */
export const CIRCUIT_EXCLUDED_CLASSES = [
  "interrupted",
  "supervisor_restart",
  "admission_refused",
] as const;

/** A hand-off packet run's trigger: neither a failure nor a recovery of the ticket's work. */
export const HANDOFF_RUN_TRIGGER = "handoff";

/** The command whose failure can strand a `staffed` ticket with no session at all. */
export const SPAWN_COMMAND = "session.spawn";

/** The class a retry storm counts: the only one the storm exclusion applies to. */
export const STORM_ERROR_CLASS = "runner_error";

/**
 * One failure of a holding session on the ticket: a failed run, a start that never ran, or a
 * `session.spawn` command that failed before it wrote a session row at all — staffing
 * has already moved the ticket to `staffed` by then, so nothing else would ever record it.
 */
export interface TicketFailure {
  readonly kind: "run" | "start" | "spawn_command";
  readonly sessionId: string;
  /** Null for a failed start or a spawn command. */
  readonly runId: string | null;
  /** Empty for a spawn command: it failed before either was resolved. */
  readonly runnerId: string;
  readonly executorId: string;
  /** The run's state, `exited` for a start, or `failed` for a spawn command. */
  readonly state: string;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  /** When it ended (runs.ended_at, sessions.ended_at, or the command's own ts). */
  readonly at: number;
}

export interface CircuitInput {
  readonly failures: readonly TicketFailure[];
  /** The latest of: an ok work run, an unblock, the ticket's creation. */
  readonly resetAt: number;
  /** watchdog.circuit_failed_runs. */
  readonly threshold: number;
  /** Each pair's holds (pairKey), from retryStormHolds over its runner_error failures. */
  readonly holdsByPair: ReadonlyMap<string, readonly StormHold[]>;
}

export interface CircuitJudgement {
  readonly tripped: boolean;
  /** The failures that count, oldest first. */
  readonly counted: readonly TicketFailure[];
}

const EXCLUDED: ReadonlySet<string> = new Set(CIRCUIT_EXCLUDED_CLASSES);
const RUN_STATES: ReadonlySet<string> = new Set(CIRCUIT_RUN_STATES);

/**
 * Whether one failure is the ticket's own (§5.1), before the storm exclusion. A spawn command is
 * judged by the same class list as everything else on purpose: a resolve that cannot find the
 * ticket's own agent or profile will fail again on every re-staff and should count, while an
 * `interrupted` attempt cap means the supervisor kept dying under it — a fleet condition, excluded
 * exactly as a restart-interrupted session is.
 */
export function isTicketFailure(f: TicketFailure): boolean {
  if (f.errorClass !== null && EXCLUDED.has(f.errorClass)) return false;
  return f.kind !== "run" || RUN_STATES.has(f.state);
}

/** A runner_error failure inside any burst of its own pair is the storm's (§5.3). */
function isStormFailure(
  f: TicketFailure,
  holdsByPair: CircuitInput["holdsByPair"],
): boolean {
  if (f.errorClass !== STORM_ERROR_CLASS) return false;
  const holds = holdsByPair.get(pairKey(f.runnerId, f.executorId)) ?? [];
  return inStormHold(f.at, holds);
}

/** Trips at `threshold` of the ticket's own failures after `resetAt`, storm failures excluded. */
export function circuitVerdict(i: CircuitInput): CircuitJudgement {
  const counted = i.failures
    .filter(
      (f) =>
        f.at > i.resetAt &&
        isTicketFailure(f) &&
        !isStormFailure(f, i.holdsByPair),
    )
    .toSorted((a, b) => a.at - b.at);
  return { tripped: counted.length >= i.threshold, counted };
}
