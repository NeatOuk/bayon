// Wires the pulse scheduler into a running supervisor: the `pulse.run` and
// `pulse.report` handlers, the session-ended and hand-off-pending hooks, and the scheduler's boot. After
// lifecycle.boot(), whose reconciler pass has already ended a pulse session that died while down.
import { PULSE_REPORT_TOOL, type Clock } from "@bayon/core";
import type { Log } from "../lifecycle/index.js";
import type { Supervisor } from "../supervisor.js";
import { contextPackBuilder } from "./context-pack.js";
import { budgetGate } from "./gate.js";
import type { ContextPackBuilder, ProbeRunner, PulseGate } from "./ports.js";
import { pulseReportHandler, pulseRunHandler } from "./pulse-commands.js";
import { createPulseScheduler, type PulseScheduler } from "./scheduler.js";

export interface PulseWiringOptions {
  readonly supervisor: Supervisor;
  readonly log: Log;
  readonly clock: Clock;
  /** $FRM_HOME: the context pack is written under runtime/pulses/. */
  readonly frmHome: string;
  /** runner (main.ts's `probeRunner`). */
  readonly probeRunner: ProbeRunner;
  /** Default: builder over this supervisor's database and FRM_HOME. */
  readonly pack?: ContextPackBuilder;
  /** M4's gate; until then the daily budget (gate.ts). */
  readonly gate?: PulseGate;
  /** Default: pulse_report, without which a pulse cannot report. */
  readonly requireTools?: readonly string[];
}

export interface PulseWiring {
  readonly scheduler: PulseScheduler;
  /** Unsubscribes and stops the scheduler. Idempotent. Kills nothing. */
  stop(): Promise<void>;
}

export async function wirePulse(o: PulseWiringOptions): Promise<PulseWiring> {
  const { db, claimer, lifecycle } = o.supervisor;
  const scheduler = createPulseScheduler({
    db,
    clock: o.clock,
    log: o.log,
    lifecycle,
    probes: o.probeRunner,
    pack: o.pack ?? contextPackBuilder({ db, frmHome: o.frmHome }),
    gate: o.gate ?? budgetGate({ db, log: o.log }),
    requireTools: o.requireTools ?? [PULSE_REPORT_TOOL],
  });
  claimer.register(pulseRunHandler(scheduler));
  claimer.register(pulseReportHandler(db));
  const offEnded = lifecycle.onSessionEnded((e) => scheduler.sessionEnded(e));
  // A pending hand-off is a completion wake too (§9.7; design §3 (b)).
  const offPending = lifecycle.onHandoffPending((e) =>
    scheduler.fanOutCompletion(e.at, e.workspaceId),
  );
  await scheduler.start();
  let stopping: Promise<void> | undefined;
  return {
    scheduler,
    stop: () =>
      (stopping ??= (async () => {
        offEnded();
        offPending();
        await scheduler.stop();
      })()),
  };
}
