import { newId, ok } from "@bayon/core";
import { allOk, check } from "../checks.js";
import {
  first,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type R,
} from "../connection.js";
import type { BackupOutcome, BackupRow } from "../schema-fleet.js";

// backups (012_fleet): one row per finished backup attempt. The nightly backup is a daemon job
// (M4-k), so the supervisor writes the table. The newest row's outcome drives v_needs_attention's
// backup_failed arm.

export interface NewBackup {
  readonly started_at: number;
  readonly ended_at: number;
  readonly outcome: BackupOutcome;
  /** The encrypted file an ok attempt wrote. */
  readonly path?: string | null;
  /** Why a failed attempt failed. */
  readonly error?: string | null;
}

const isSet = (text: string | null): boolean =>
  text !== null && text.trim().length > 0;

/** Records one finished attempt: an ok one names its file, a failed one says why. */
export async function recordBackup(db: Db, b: NewBackup): R<BackupRow> {
  const path = b.path ?? null;
  const error = b.error ?? null;
  const checked = allOk(
    check(
      Number.isInteger(b.started_at) &&
        Number.isInteger(b.ended_at) &&
        b.ended_at >= b.started_at,
      "a backup ends at or after it starts, both in epoch millis",
    ),
    check(b.outcome !== "ok" || isSet(path), "an ok backup names its file"),
    check(b.outcome !== "failed" || isSet(error), "a failed backup says why"),
  );
  if (!checked.ok) return checked;
  return write(db, (ix) =>
    returningOne(
      ix,
      qb
        .insertInto("backups")
        .values({
          id: newId(ix.clock.now()),
          started_at: b.started_at,
          ended_at: b.ended_at,
          outcome: b.outcome,
          path,
          error,
        })
        .returningAll(),
    ),
  );
}

/**
 * `frm backup`'s own attempt: the same row through @bayon/db/operator, the CLI's one door
 * (Invariant 5's exception), so an on-demand backup clears or raises backup_failed as well.
 */
export const recordOperatorBackup = (db: Db, b: NewBackup): R<BackupRow> =>
  recordBackup(db, b);

/** The newest attempt by ended_at, or null before the first. */
export async function getLastBackup(db: Db): R<BackupRow | null> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("backups")
        .selectAll()
        .orderBy("ended_at", "desc")
        .orderBy("id", "desc"),
    ),
  );
  return found.ok ? ok(found.value ?? null) : found;
}
