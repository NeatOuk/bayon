// The conformance watchdog in the supervisor's run-timer order (§5.2; lifecycle/run.ts onTimeout
// then tearDown). No terminal within the wall clock: the verdict first, as the run timer's CAS on
// runs.state, so a later terminal cannot win it; then interrupt, wait the grace for the runner's
// terminal, and stop, graceful if it came and a kill if not. The process's EOF then closes the run
// with runs.state. Every step on the adapter is bounded, and a stop that never settles falls back
// to the executor's hard cleanup, so a hung runner fails one test and the suite goes on.
import type { Clock, Result } from "@bayon/core";
import {
  untilElapsed,
  type IngestPort,
  type WatchdogPort,
  type WatchResult,
} from "@bayon/runners/conformance";
import { settlesWithin } from "../lifecycle/async-util.js";

export interface SupervisorWatchdogOptions {
  readonly clock: Clock;
  readonly ingest: IngestPort;
  /** The run timer's verdict: runs.state = timeout, unless a terminal already won. */
  readonly timeout: (
    runId: string,
    message: string,
  ) => Promise<Result<unknown>>;
  /** lifecycle.interrupt_grace_ms's part here: the wait for the runner's own terminal. */
  readonly graceMs: number;
  /** The bound on stop and on the EOF after it. */
  readonly stopMs: number;
}

export function supervisorWatchdog(o: SupervisorWatchdogOptions): WatchdogPort {
  return {
    source: "supervisor",
    async watch(w): Promise<WatchResult> {
      const cancel = new AbortController();
      const armedAt = o.clock.now();
      const first = await Promise.race([
        o.ingest
          .terminalOf(w.runId)
          .then((outcome) => ({ by: "terminal" as const, outcome })),
        // Never before its wall clock by the clock the verdict is read with: a system timer can
        // fire a few ms early, and §15 #9's fired_on_time then fails a certification.
        untilElapsed(o.clock, armedAt, w.wallClockMs, cancel.signal).then(
          () => "fired" as const,
          () => "fired" as const,
        ),
      ]);
      cancel.abort();
      if (first !== "fired") return first;
      const firedAt = o.clock.now();
      await w.onFire?.();
      const message = `no terminal within ${w.wallClockMs} ms`;
      const verdict = await o.timeout(w.runId, message);
      if (!verdict.ok) {
        // The CAS lost: a terminal won the run, as it does against the run timer.
        return { by: "terminal", outcome: await o.ingest.terminalOf(w.runId) };
      }
      await settlesWithin(w.adapter.interrupt(w.handle), o.clock, o.graceMs);
      const seen = await settlesWithin(
        o.ingest.terminalOf(w.runId),
        o.clock,
        o.graceMs,
      );
      const stopped = await settlesWithin(
        w.adapter.stop(w.handle, seen ? "graceful" : "kill"),
        o.clock,
        o.stopMs,
      );
      if (!stopped) {
        await w.executor
          .cleanup(w.handle.executorRef, "hard")
          .catch(() => undefined); // already gone
      }
      const closed = await settlesWithin(
        o.ingest.terminalOf(w.runId),
        o.clock,
        o.stopMs,
      );
      if (!closed) {
        // No EOF after the kill: close it as the EOF would, with runs.state.
        await o.ingest.closeRun(w.sessionId, w.runId, {
          outcome: "timeout",
          errorClass: "timeout",
          message,
        });
      }
      return {
        by: "watchdog",
        outcome: await o.ingest.terminalOf(w.runId),
        firedAt,
      };
    },
  };
}
