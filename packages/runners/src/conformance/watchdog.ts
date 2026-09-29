// The reference watchdog (§5.2, §13.2): the order of the supervisor's run timer
// (apps/supervisor/src/lifecycle/run.ts onTimeout → tearDown). A run ends only on a terminal; none
// inside the wall clock is a `timeout`, written first, then the process is taken down. Every await
// on the adapter is bounded, so a hung adapter cannot hang the watchdog. Runner-neutral.
import type { Clock } from "@bayon/core";
import { settlesWithin } from "../wait.js";
import type { IngestPort, WatchdogPort, WatchResult } from "./types.js";

export interface ReferenceWatchdogOptions {
  readonly clock: Clock;
  readonly ingest: IngestPort;
  /** The bound on `interrupt` after the verdict. */
  readonly graceMs: number;
  /** The bound on `stop(kill)`; past it, the executor's hard cleanup. */
  readonly stopMs: number;
}

/**
 * Resolves once `clock.now()` reads at least `ms` past `from`. A system timer can fire a
 * millisecond or so early by the clock the verdict is read with (Node arms it from the event loop's
 * cached time, staler under load), and a watchdog that fires before its own wall clock fails
 * §15 #9's `fired_on_time`. The supervisor's watchdog port waits with it too.
 */
export async function untilElapsed(
  clock: Clock,
  from: number,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  for (let left = ms; left > 0; left = from + ms - clock.now()) {
    await clock.after(left, signal);
  }
}

export function createReferenceWatchdog(
  o: ReferenceWatchdogOptions,
): WatchdogPort {
  return {
    source: "reference",
    async watch(w): Promise<WatchResult> {
      const cancel = new AbortController();
      const armedAt = o.clock.now();
      const first = await Promise.race([
        o.ingest
          .terminalOf(w.runId)
          .then((outcome) => ({ by: "terminal" as const, outcome })),
        untilElapsed(o.clock, armedAt, w.wallClockMs, cancel.signal).then(
          () => "fire" as const,
          () => "fire" as const,
        ),
      ]);
      cancel.abort();
      if (first !== "fire") return first;
      const firedAt = o.clock.now();
      await w.onFire?.();
      // The verdict first: a terminal{interrupted} arriving later cannot win it.
      await o.ingest.closeRun(w.sessionId, w.runId, {
        outcome: "timeout",
        errorClass: "timeout",
        message: `no terminal within ${w.wallClockMs} ms`,
      });
      await settlesWithin(w.adapter.interrupt(w.handle), o.clock, o.graceMs);
      const stopped = await settlesWithin(
        w.adapter.stop(w.handle, "kill"),
        o.clock,
        o.stopMs,
      );
      if (!stopped) {
        await w.executor
          .cleanup(w.handle.executorRef, "hard")
          .catch(() => undefined); // an already-dead or foreign ref: nothing left to kill
      }
      return {
        by: "watchdog",
        outcome: await o.ingest.terminalOf(w.runId),
        firedAt,
      };
    },
  };
}
