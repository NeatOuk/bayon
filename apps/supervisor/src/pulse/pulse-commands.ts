// The pulse commands the API inserts (§9.5): `pulse.run` (POST /pulses/run-now) and
// `pulse.report` (the orchestrator's pulse_report tool). Both settle fast.
import { ok } from "@bayon/core";
import type { Db } from "@bayon/db";
import { applyPulseReport } from "@bayon/db/supervisor";
import { PulseReportPayload, PulseRunPayload } from "@bayon/proto";
import type { CommandHandler } from "../commands/claimer.js";
import type { PulseScheduler } from "./scheduler.js";

/** `pulse.run`: one pulse now, or the live one's id (`coalesced`), or the cap's row (`capped`). */
export function pulseRunHandler(
  scheduler: PulseScheduler,
): CommandHandler<PulseRunPayload> {
  return {
    type: "pulse.run",
    payload: PulseRunPayload,
    // A re-delivery would start a second pulse nobody asked for.
    idempotent: false,
    async handle(p) {
      const ran = await scheduler.runNow(p.agent_id);
      return ran.ok
        ? ok({ pulse_id: ran.value.pulse_id, outcome: ran.value.outcome })
        : ran;
    },
  };
}

/**
 * `pulse.report` (review H1, M3): off the agent's queue. A report for a pulse that has already
 * settled is not an error: settlePulse applied it, or it came too late (`applied: false`).
 */
export function pulseReportHandler(db: Db): CommandHandler<PulseReportPayload> {
  return {
    type: "pulse.report",
    payload: PulseReportPayload,
    // A CAS on the running pulse and its session: a second apply is `applied: false`.
    idempotent: true,
    async handle(p) {
      const applied = await applyPulseReport(db, {
        pulse_id: p.pulse_id,
        session_id: p.session_id,
        summary_md: p.summary_md,
        actions: p.actions,
      });
      return applied.ok
        ? ok({ pulse_id: p.pulse_id, applied: applied.value.applied })
        : applied;
    },
  };
}
