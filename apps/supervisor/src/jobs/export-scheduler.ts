// A supervisor-internal timer that re-triggers the exporter every `exports.interval_ms` (design
// doc §6), driven entirely by the injected Clock -- no sleeps. 0 or absent means off (the coordinator's
// decision): `tick` is never called and `start()` is a no-op. No `commands` row: the supervisor
// owns sessions, so triggering itself needs none (Invariant 5 governs who may *insert* a command).
import type { Clock } from "@bayon/core";

export interface ExportSchedulerOptions {
  readonly clock: Clock;
  /** `exports.interval_ms`; <= 0 disables the timer entirely. */
  readonly intervalMs: number;
  /** Called on every tick; errors are the caller's to log -- this loop never stops on one. */
  readonly tick: () => Promise<void>;
  readonly onError?: (e: unknown) => void;
}

export interface ExportScheduler {
  start(): void;
  /** Cancels the pending wait; a tick already running is not interrupted. */
  stop(): void;
}

export function createExportScheduler(
  o: ExportSchedulerOptions,
): ExportScheduler {
  const abort = new AbortController();
  let started = false;

  function loop(): void {
    o.clock.after(o.intervalMs, abort.signal).then(
      async () => {
        try {
          await o.tick();
        } catch (e) {
          o.onError?.(e);
        }
        loop();
      },
      () => undefined, // stop() aborted the wait
    );
  }

  return {
    start() {
      if (started || o.intervalMs <= 0) return;
      started = true;
      loop();
    },
    stop() {
      abort.abort();
    },
  };
}
