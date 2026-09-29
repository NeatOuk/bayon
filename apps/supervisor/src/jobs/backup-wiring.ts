// Wires the nightly backup into the running daemon: the crash sweep, then the scheduler
// over the Clock and the job with the supervisor's secret stores. No command type: the supervisor
// triggers its own job, and `frm backup` takes an on-demand one from the CLI.
import { dirname } from "node:path";
import { ok, type Clock } from "@bayon/core";
import {
  getLastBackup,
  sweepBackupTemps,
  sweepRestoreTemps,
  type Db,
} from "@bayon/db";
import type { HostSecretStores } from "@bayon/executors";
import type { Logger } from "pino";
import { backupsDir, dbPath, eventsArchiveDir } from "../paths.js";
import { BACKUP_NOT_SET_UP, runBackupJob } from "./backup-job.js";
import { createBackupScheduler } from "./backup-schedule.js";
import { loadBackupSettings } from "./backup-settings.js";
import { runRetention } from "./retention.js";

export interface BackupWiringOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  readonly home: string;
  readonly secrets: HostSecretStores;
  /** The live database (FRM_DB): a restore onto it may have left a copy beside it. */
  readonly liveDb?: string;
  readonly recheckMs?: number;
}

export interface BackupWiring {
  /** Stops the scheduler, waiting for a running backup. Idempotent. */
  stop(): Promise<void>;
  /**
   * Retention now, for the watchdog's low-disk rule: one at a time with the nightly
   * job, so two runs never write the same archive file. runRetention's own precondition (today's
   * backup succeeded, UTC) still decides; this never starts a backup.
   */
  retentionNow(reason: string): Promise<void>;
}

/** Removes the plaintext temp files a backup or restore killed mid-way left (SIGKILL, OOM). */
function sweepAtBoot(o: BackupWiringOptions): void {
  const now = o.clock.now();
  const liveDir = dirname(o.liveDb ?? dbPath(o.home));
  for (const swept of [
    sweepBackupTemps(backupsDir(o.home), now),
    sweepRestoreTemps(liveDir, now),
  ]) {
    if (!swept.ok) {
      o.log.error(
        { error: swept.error },
        "cannot sweep stale backup temp files",
      );
      continue;
    }
    if (swept.value.removed.length > 0) {
      o.log.warn(
        { removed: swept.value.removed },
        "removed plaintext temp files a dead backup or restore left",
      );
    }
    if (swept.value.failed.length > 0) {
      o.log.error(
        { failed: swept.value.failed },
        "stale backup temp files could not be removed",
      );
    }
  }
}

export function wireBackups(o: BackupWiringOptions): BackupWiring {
  sweepAtBoot(o);
  // The nightly job and an early retention run one at a time.
  let busy: Promise<void> = Promise.resolve();
  const serial = (op: () => Promise<void>): Promise<void> => {
    const next = busy.then(op);
    busy = next.catch(() => undefined);
    return next;
  };
  const retentionNow = (reason: string): Promise<void> =>
    serial(async () => {
      const settings = await loadBackupSettings(o.db);
      if (!settings.ok) {
        o.log.error({ error: settings.error }, "early retention: no settings");
        return;
      }
      const ran = await runRetention({
        db: o.db,
        clock: o.clock,
        archiveDir: eventsArchiveDir(o.home),
        eventsDays: settings.value["retention.events_days"],
        keepReasoning: settings.value["retention.reasoning"] === "keep",
      });
      if (!ran.ok) {
        o.log.error({ reason, error: ran.error }, "early retention failed");
      } else if (!ran.value.ran) {
        o.log.warn(
          { reason, held: ran.value.reason },
          "early retention held: it runs only after today's good backup",
        );
      } else {
        o.log.info(
          { reason, archived: ran.value.archived },
          "early retention done",
        );
      }
    });
  let toldNotSetUp = false;
  const scheduler = createBackupScheduler({
    clock: o.clock,
    loadSettings: () => loadBackupSettings(o.db),
    attemptedSince: async (slot) => {
      const last = await getLastBackup(o.db);
      return last.ok
        ? ok(last.value !== null && last.value.started_at >= slot)
        : last;
    },
    run: (settings) =>
      serial(async () => {
        const result = await runBackupJob(
          {
            db: o.db,
            clock: o.clock,
            log: o.log,
            home: o.home,
            secrets: o.secrets,
          },
          settings,
        );
        // Not set up: one warn line per process with the fix, then quiet until a key appears.
        if (result.notSetUp === true && !toldNotSetUp) {
          toldNotSetUp = true;
          o.log.warn(BACKUP_NOT_SET_UP);
        } else if (result.notSetUp !== true) {
          toldNotSetUp = false;
        }
      }),
    onError: (error) => o.log.error({ error }, "backup scheduler"),
    ...(o.recheckMs === undefined ? {} : { recheckMs: o.recheckMs }),
  });
  scheduler.start();
  return { stop: () => scheduler.stop(), retentionNow };
}
