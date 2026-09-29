// When the nightly backup runs (§13.2): at backup.at_utc_hour:00 UTC, driven by the
// injected Clock (no sleeps). Each tick re-reads the settings and runs the job if it is enabled and
// no attempt has started since the latest slot, so a supervisor that was down at the hour catches
// up once when it starts, and a restart after the night's attempt does not repeat it. A tick waits
// for the next slot, or `recheckMs` at most, so a changed hour or flag is seen within it.
import type { Clock, Result } from "@bayon/core";
import type { BackupSettings } from "./backup-settings.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How often a waiting scheduler re-reads its settings. */
export const BACKUP_RECHECK_MS = HOUR_MS;

/** The latest `hour`:00 UTC at or before `now`. */
export function slotAtOrBefore(now: number, hour: number): number {
  const slot = now - (now % DAY_MS) + hour * HOUR_MS;
  return slot <= now ? slot : slot - DAY_MS;
}

/** The first `hour`:00 UTC after `now`. */
export const nextSlotAfter = (now: number, hour: number): number =>
  slotAtOrBefore(now, hour) + DAY_MS;

export interface BackupSchedulerOptions {
  readonly clock: Clock;
  readonly loadSettings: () => Promise<Result<BackupSettings>>;
  /** Whether a backup attempt started at or after `slot`. */
  readonly attemptedSince: (slot: number) => Promise<Result<boolean>>;
  /** The job; its own failures are its to record and log. */
  readonly run: (settings: BackupSettings) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly recheckMs?: number;
}

export interface BackupScheduler {
  start(): void;
  /** Cancels the wait and resolves once a running job has finished. Idempotent. */
  stop(): Promise<void>;
}

export function createBackupScheduler(
  o: BackupSchedulerOptions,
): BackupScheduler {
  const abort = new AbortController();
  const recheck = o.recheckMs ?? BACKUP_RECHECK_MS;
  let started = false;
  let running: Promise<void> = Promise.resolve();

  /** One tick; resolves to how long to wait for the next. */
  async function tick(): Promise<number> {
    const settings = await o.loadSettings();
    if (!settings.ok) {
      o.onError(settings.error);
      return recheck;
    }
    const hour = settings.value["backup.at_utc_hour"];
    if (settings.value["backup.enabled"] === 1 && !abort.signal.aborted) {
      const done = await o.attemptedSince(slotAtOrBefore(o.clock.now(), hour));
      if (!done.ok) o.onError(done.error);
      else if (!done.value) await o.run(settings.value);
    }
    const now = o.clock.now();
    return Math.min(nextSlotAfter(now, hour) - now, recheck);
  }

  function loop(): void {
    running = (async () => {
      let wait = recheck;
      try {
        wait = await tick();
      } catch (e) {
        o.onError(e);
      }
      if (abort.signal.aborted) return;
      o.clock.after(wait, abort.signal).then(loop, () => undefined);
    })();
  }

  return {
    start() {
      if (started) return;
      started = true;
      loop();
    },
    async stop() {
      abort.abort();
      await running;
    },
  };
}
