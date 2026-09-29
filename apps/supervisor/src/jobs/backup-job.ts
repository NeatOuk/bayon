// The nightly backup (§13.2, §14): the key from the host secret store, the encrypted
// file (writeBackup), one `backups` row for every attempt, ok or failed, and then, only after a
// good one, event retention. Nothing here formats the key: a log line or an error names its id.
import { type Clock, type Result } from "@bayon/core";
import {
  BACKUP_KEY_NAME,
  BackupKey,
  backupKeyEnvWarning,
  type Db,
} from "@bayon/db";
import {
  recordBackup,
  writeBackup,
  type WrittenBackup,
} from "@bayon/db/supervisor";
import { getSourced, type HostSecretStores } from "@bayon/executors";
import type { Logger } from "pino";
import { backupsDir, eventsArchiveDir } from "../paths.js";
import type { BackupSettings } from "./backup-settings.js";
import { runRetention, type RetentionOutcome } from "./retention.js";

export interface BackupJobDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  /** FRM_HOME: backups/ and archive/events/ live under it. */
  readonly home: string;
  /** The supervisor's two secret stores: FRM_SECRET_FRM_BACKUP_KEY, then the Keychain. */
  readonly secrets: HostSecretStores;
}

export interface BackupJobResult {
  readonly backup: Result<WrittenBackup>;
  /** Null when the backup failed: retention never runs after a bad one. */
  readonly retention: Result<RetentionOutcome> | null;
}

/**
 * The backup key as the secret store holds it, parsed; a miss or a bad value names no value. The
 * environment wins over the Keychain (spawn secrets' order), so when it does, a warning says so.
 */
export const backupKeyFrom =
  (stores: HostSecretStores, log: Logger) =>
  async (): Promise<Result<BackupKey>> => {
    const text = await getSourced(stores, BACKUP_KEY_NAME);
    if (!text.ok) return text;
    if (text.value.source === "env") {
      log.warn(
        { secret: BACKUP_KEY_NAME, source: `FRM_SECRET_${BACKUP_KEY_NAME}` },
        backupKeyEnvWarning(),
      );
    }
    return BackupKey.fromHex(text.value.value);
  };

export async function runBackupJob(
  d: BackupJobDeps,
  settings: BackupSettings,
): Promise<BackupJobResult> {
  const startedAt = d.clock.now();
  const backup = await writeBackup({
    db: d.db,
    dir: backupsDir(d.home),
    key: backupKeyFrom(d.secrets, d.log),
    keep: settings["backup.keep"],
    clock: d.clock,
  });
  const endedAt = Math.max(d.clock.now(), startedAt);
  const recorded = await recordBackup(
    d.db,
    backup.ok
      ? {
          started_at: startedAt,
          ended_at: endedAt,
          outcome: "ok",
          path: backup.value.path,
        }
      : {
          started_at: startedAt,
          ended_at: endedAt,
          outcome: "failed",
          error: backup.error.message,
        },
  );
  if (!recorded.ok) {
    d.log.error({ error: recorded.error }, "cannot record the backup attempt");
  }
  if (!backup.ok) {
    d.log.error({ error: backup.error }, "backup failed; retention skipped");
    return { backup, retention: null };
  }
  const { path, key_id, bytes, pruned } = backup.value;
  d.log.info(
    { path, key_id, bytes, pruned: pruned.removed.length },
    "backup written",
  );
  if (pruned.failed.length > 0) {
    d.log.warn({ failed: pruned.failed }, "some old backups were not pruned");
  }
  // Retention reads the row just written: without it (a failed record) it does not run.
  const retention = await runRetention({
    db: d.db,
    clock: d.clock,
    archiveDir: eventsArchiveDir(d.home),
    eventsDays: settings["retention.events_days"],
    keepReasoning: settings["retention.reasoning"] === "keep",
  });
  if (!retention.ok) {
    d.log.error({ error: retention.error }, "event retention failed");
  } else if (!retention.value.ran) {
    d.log.warn({ reason: retention.value.reason }, "event retention skipped");
  } else {
    d.log.info(
      {
        archived: retention.value.archived,
        files: retention.value.files.length,
      },
      "event retention done",
    );
  }
  return { backup, retention };
}
