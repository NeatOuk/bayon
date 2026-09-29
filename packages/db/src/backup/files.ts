import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ok, type Result } from "@bayon/core";
import { capture } from "../errors.js";

// Backup file names: foreman-<UTC stamp to the millisecond>Z.frmbak, so a lexical sort
// is a chronological one. Pruning only ever touches names of this shape in the backups directory.

const NAME = /^foreman-\d{8}T\d{9}Z\.frmbak$/;

/** The backups directory under FRM_HOME: the supervisor's nightly job and `frm backup` share it. */
export const BACKUPS_DIR = "backups";

/** `20260914T030000123Z` for 2026-09-14T03:00:00.123Z. */
export const utcStamp = (at: number): string =>
  new Date(at).toISOString().replace(/[-:.]/g, "");

/** `foreman-20260914T030000123Z.frmbak` for 2026-09-14T03:00:00.123Z. */
export const backupFileName = (at: number): string =>
  `foreman-${utcStamp(at)}.frmbak`;

export const isBackupFileName = (name: string): boolean => NAME.test(name);

/** The backups in `dir`, oldest first; an absent directory has none. */
export function listBackupFiles(dir: string): Result<readonly string[]> {
  if (!existsSync(dir)) return ok([]);
  const listed = capture(() => readdirSync(dir));
  return listed.ok
    ? ok(listed.value.filter(isBackupFileName).toSorted())
    : listed;
}

export interface Pruned {
  /** Removed, oldest first. */
  readonly removed: readonly string[];
  /** Past `keep` but could not be removed, with why. */
  readonly failed: readonly string[];
}

/** Removes all but the newest `keep` backups in `dir`. Nothing else in `dir` is touched. */
export function pruneBackups(dir: string, keep: number): Result<Pruned> {
  const listed = listBackupFiles(dir);
  if (!listed.ok) return listed;
  const excess = listed.value.slice(0, Math.max(0, listed.value.length - keep));
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of excess) {
    const gone = capture(() => rmSync(join(dir, name)));
    if (gone.ok) removed.push(name);
    else failed.push(`${name}: ${gone.error.message}`);
  }
  return ok({ removed, failed });
}
