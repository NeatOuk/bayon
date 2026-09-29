// Silence: a process whose executor reports no exit, in a running session
// whose open run has had no event for watchdog.silent_ms. It is probed through its executor,
// outside the watchdog queue, and the outcome applied in a queue op (N4). A probe only says
// whether the process exists: `alive` does nothing, and `dead` or `unknown` never kill while the
// executor reports no exit. The run's wall clock stays the only verdict (Invariant 3).
import type { ProbeState } from "@bayon/executors";
import { getOpenRun, getSession } from "@bayon/db";
import type { LiveProcessView, WatchdogDeps } from "./ports.js";

export interface SilenceMemory {
  /** When each session was last probed: one probe per silence window. */
  readonly probedAt: Map<string, number>;
}

export interface ProbeOutcome {
  readonly sessionId: string;
  readonly ref: string;
  readonly state: ProbeState | "unknown";
  /** How long its open run has been silent. */
  readonly silentMs: number;
}

/** The probe, bounded: a throw or the timeout is `unknown`. */
async function boundedProbe(
  d: WatchdogDeps,
  p: LiveProcessView,
): Promise<ProbeState | "unknown"> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      p.executor.probe(p.ref),
      d.clock
        .after(d.probeTimeoutMs(), timeout.signal)
        .then(() => "unknown" as const),
    ]);
  } catch {
    return "unknown";
  } finally {
    timeout.abort();
  }
}

/** When the open run was last heard from, or null when the session is not running a run. */
async function observedSince(
  d: WatchdogDeps,
  sessionId: string,
): Promise<number | null> {
  const session = await getSession(d.db, sessionId);
  if (!session.ok || session.value.state !== "running") return null;
  const open = await getOpenRun(d.db, sessionId);
  if (!open.ok || open.value === null) return null;
  return Math.max(session.value.last_event_at ?? 0, open.value.started_at);
}

/** Probes each silent session once per window. Outside the queue: it only reads and probes. */
export async function probeSilent(
  d: WatchdogDeps,
  silentMs: number,
  memory: SilenceMemory,
): Promise<readonly ProbeOutcome[]> {
  const now = d.clock.now();
  const outcomes: ProbeOutcome[] = [];
  for (const p of d.liveProcesses()) {
    if ((p.executor.exitedAt?.(p.ref) ?? null) !== null) continue; // §3.1's case
    const since = await observedSince(d, p.sessionId);
    if (since === null) continue;
    const last = Math.max(since, memory.probedAt.get(p.sessionId) ?? 0);
    if (now - last < silentMs) continue;
    outcomes.push({
      sessionId: p.sessionId,
      ref: p.ref,
      state: await boundedProbe(d, p),
      silentMs: now - since,
    });
  }
  return outcomes;
}

/** In a queue op: records the probes and logs them. Nothing else happens on any outcome. */
export function applyProbes(
  d: WatchdogDeps,
  outcomes: readonly ProbeOutcome[],
  memory: SilenceMemory,
): void {
  const now = d.clock.now();
  for (const o of outcomes) {
    memory.probedAt.set(o.sessionId, now);
    d.log.warn(
      {
        sessionId: o.sessionId,
        ref: o.ref,
        probe: o.state,
        silentMs: o.silentMs,
      },
      o.state === "alive"
        ? "silent: its open run has had no event, and its process is alive; the wall clock decides"
        : "silent: its open run has had no event, and its executor reports no exit; the wall clock decides",
    );
  }
}
