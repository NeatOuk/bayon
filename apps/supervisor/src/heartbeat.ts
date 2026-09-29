// The supervisor's heartbeat row in supervisor_state, written on the injected clock.
import { ok, type Clock, type Result } from "@bayon/core";
import type { Db } from "@bayon/db";
import { heartbeat } from "@bayon/db/supervisor";
import type { Logger } from "pino";

export const HEARTBEAT_INTERVAL_MS = 5_000;

export interface HeartbeatOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  readonly pid: number;
  readonly version: string;
  readonly startedAt: number;
  readonly intervalMs?: number;
}

export interface Heartbeat {
  stop(): Promise<void>;
}

/**
 * Beats once, then every interval. A failed first beat fails the start; a later one is logged
 * and retried on the next tick.
 */
export async function startHeartbeat(
  o: HeartbeatOptions,
): Promise<Result<Heartbeat>> {
  const beat = () =>
    heartbeat(o.db, { pid: o.pid, version: o.version, startedAt: o.startedAt });
  const first = await beat();
  if (!first.ok) return first;
  const stopper = new AbortController();
  const interval = o.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const loop = (async () => {
    for (;;) {
      try {
        await o.clock.after(interval, stopper.signal);
      } catch {
        return; // stop() aborted the wait
      }
      const next = await beat();
      if (!next.ok) o.log.error({ error: next.error }, "heartbeat failed");
    }
  })();
  return ok({
    stop: async () => {
      stopper.abort();
      await loop;
    },
  });
}
