// A pulse's end: its session ended, so it settles; and the sweep, at boot
// and every tick, ends what a restart or a missed event left live.
import type { SessionState } from "@bayon/core";
import {
  LIVE_PULSE_STATES,
  getPulse,
  getSession,
  listLivePulses,
  listRuns,
  type PulseRow,
  type SessionRow,
} from "@bayon/db";
import { resumPulseCosts, settlePulse } from "@bayon/db/supervisor";
import type { PulseRuntime } from "./runtime.js";

/** A session in one of these has no process and never gets one back. */
const ENDED: readonly SessionState[] = ["exited", "resumable", "handed_off"];

const isLive = (pulse: PulseRow): boolean =>
  (LIVE_PULSE_STATES as readonly string[]).includes(pulse.state);

/** Fails a pulse that never got a session to settle it (a refused spawn, a restart). */
export async function failPulse(
  rt: PulseRuntime,
  pulse: Pick<PulseRow, "id" | "agent_id">,
  reason: string,
): Promise<void> {
  const settled = await settlePulse(rt.db, {
    id: pulse.id,
    run: null,
    fail_reason: reason,
  });
  if (!settled.ok) {
    if (settled.error.class !== "conflict") {
      rt.log.error(
        { pulseId: pulse.id, error: settled.error },
        "cannot fail the pulse",
      );
    }
    return;
  }
  rt.log.warn({ pulseId: pulse.id, reason }, "pulse failed");
  rt.replan(pulse.agent_id);
}

/** The session-ended hook: settles the pulse `pulseId` if its session has ended. */
export async function settleSessionPulse(
  rt: PulseRuntime,
  pulseId: string,
): Promise<void> {
  const pulse = await getPulse(rt.db, pulseId);
  if (!pulse.ok || !isLive(pulse.value) || pulse.value.session_id === null) {
    return;
  }
  const session = await getSession(rt.db, pulse.value.session_id);
  if (!session.ok) {
    rt.log.error({ pulseId, error: session.error }, "pulse: no session");
    return;
  }
  if (ENDED.includes(session.value.state)) {
    await settle(rt, pulse.value, session.value);
  }
}

/**
 * Settles a live pulse whose session has ended: run 1's facts, `unreported` without a report, or
 * the session's error when no run ever opened. A conflict means another path settled it.
 */
async function settle(
  rt: PulseRuntime,
  pulse: PulseRow,
  session: SessionRow,
): Promise<void> {
  const runs = await listRuns(rt.db, session.id);
  const run1 = runs.ok ? runs.value[0] : undefined;
  const settled = await settlePulse(rt.db, {
    id: pulse.id,
    run:
      run1 === undefined
        ? null
        : {
            run_id: run1.id,
            context_pack_path: run1.prompt_path,
            context_tokens: run1.prompt_tokens_est,
          },
    fail_reason:
      run1 === undefined
        ? (session.error_class ?? "interrupted")
        : "unreported",
  });
  if (!settled.ok) {
    if (settled.error.class !== "conflict") {
      rt.log.error(
        { pulseId: pulse.id, error: settled.error },
        "cannot settle the pulse",
      );
    }
    return;
  }
  rt.sessions.delete(session.id);
  const { state, skip_reason, cost_usd } = settled.value;
  rt.log.info(
    { pulseId: pulse.id, state, reason: skip_reason, costUsd: cost_usd },
    "pulse settled",
  );
  rt.replan(pulse.agent_id);
}

/**
 * The orphan sweep (review H4), at boot and every tick: a live pulse with no session that this
 * process is not running fails `interrupted` (at boot, every such pulse); one whose session ended
 * settles; one whose run 1 ended without its session stopping has the session stopped. Then the
 * costs of recently ended pulses are re-summed (review M4).
 */
export async function sweepPulses(rt: PulseRuntime): Promise<void> {
  const live = await listLivePulses(rt.db);
  if (!live.ok) {
    rt.log.error({ error: live.error }, "pulse sweep: cannot list pulses");
    return;
  }
  for (const pulse of live.value) await sweepOne(rt, pulse);
  const since = rt.clock.now() - rt.settings()["pulse.lease_ttl_ms"];
  const resummed = await resumPulseCosts(rt.db, since);
  if (!resummed.ok) {
    rt.log.error({ error: resummed.error }, "pulse sweep: cannot re-sum costs");
  }
}

async function sweepOne(rt: PulseRuntime, pulse: PulseRow): Promise<void> {
  if (pulse.session_id === null) {
    if (!rt.inFlight.has(pulse.id)) await failPulse(rt, pulse, "interrupted");
    return;
  }
  const sessionId = pulse.session_id;
  rt.sessions.set(sessionId, pulse.id);
  const session = await getSession(rt.db, sessionId);
  if (!session.ok) {
    rt.log.error(
      { pulseId: pulse.id, error: session.error },
      "pulse: no session",
    );
    return;
  }
  if (ENDED.includes(session.value.state)) {
    await settle(rt, pulse, session.value);
    return;
  }
  const runs = await listRuns(rt.db, sessionId);
  const run1 = runs.ok ? runs.value[0] : undefined;
  if (run1 !== undefined && run1.state !== "running") {
    rt.track(
      "stop an orphaned pulse session",
      rt.lifecycle.stop(sessionId, "graceful"),
    );
  }
}
