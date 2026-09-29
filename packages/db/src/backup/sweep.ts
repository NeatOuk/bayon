import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ok, type Result } from "@bayon/core";
import { capture } from "../errors.js";

// Plaintext temp files outlive their process only when it dies mid-way (SIGKILL, OOM, power loss):
// writeBackup's snapshot and staged ciphertext in the backups directory, and restoreBackup's
// decrypted copy (with its SQLite sidecars) beside a restore target. Both remove them in-process;
// these sweeps remove what a dead process left, at supervisor boot and when `frm backup` or `frm
// restore` starts. By exact name pattern only (the random UUID included): never the live database,
// never a finished foreman-*.frmbak, never anything else in the directory.

/**
 * A temp file untouched for this long belongs to no running backup or restore: an hour. A snapshot
 * and a decrypted copy are written continuously while their job runs, so a live one stays fresher.
 */
export const STALE_TEMP_MS = 60 * 60_000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SIDECAR = "(?:-wal|-shm|-journal)?";
/** writeBackup's `.snapshot-<uuid>.db` (and sidecars) and `.staged-<uuid>.frmbak`. */
export const BACKUP_TEMP = new RegExp(
  `^\\.(?:snapshot-${UUID}\\.db${SIDECAR}|staged-${UUID}\\.frmbak)$`,
);
/** restoreBackup's `.<target name>.restore-<uuid>` (and sidecars). */
export const RESTORE_TEMP = new RegExp(`^\\..+\\.restore-${UUID}${SIDECAR}$`);

export interface Swept {
  /** Removed, in directory order. */
  readonly removed: readonly string[];
  /** Stale but not removed, with why. */
  readonly failed: readonly string[];
}

function sweep(
  dir: string,
  pattern: RegExp,
  now: number,
  olderThanMs: number,
): Result<Swept> {
  if (!existsSync(dir)) return ok({ removed: [], failed: [] });
  const listed = capture(() => readdirSync(dir));
  if (!listed.ok) return listed;
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of listed.value.filter((n) => pattern.test(n))) {
    const path = join(dir, name);
    // lstat: a symlink or a directory with a temp file's name is not one of ours.
    const stat = capture(() => lstatSync(path));
    if (!stat.ok) {
      if (existsSync(path)) failed.push(`${path}: ${stat.error.message}`);
      continue;
    }
    if (!stat.value.isFile() || now - stat.value.mtimeMs < olderThanMs)
      continue;
    const gone = capture(() => rmSync(path, { force: true }));
    if (gone.ok) removed.push(path);
    else failed.push(`${path}: ${gone.error.message}`);
  }
  return ok({ removed, failed });
}

/** Stale snapshots and staged ciphertext in a backups directory. */
export const sweepBackupTemps = (
  dir: string,
  now: number,
  olderThanMs = STALE_TEMP_MS,
): Result<Swept> => sweep(dir, BACKUP_TEMP, now, olderThanMs);

/** Stale decrypted copies beside a restore target, in its directory. */
export const sweepRestoreTemps = (
  dir: string,
  now: number,
  olderThanMs = STALE_TEMP_MS,
): Result<Swept> => sweep(dir, RESTORE_TEMP, now, olderThanMs);
