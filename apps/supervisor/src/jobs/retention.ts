// Event retention (§4 retention, §13.2). The events of tickets closed more than
// retention.events_days ago go to gzipped JSONL under archive/events/<UTC day>/, then leave the
// events table, one batch of RETENTION_BATCH rows per file and per transaction. It runs only when
// the newest backup attempt succeeded today (UTC): a bad night keeps every row.
//
// What stays: raw logs (runtime/sessions/<id>/logs/stdout.jsonl) and the payload files beside them
// are not touched. They are the replay source, and a new segment starts at max(file size, last
// committed offset), so with the file kept no offset is reused even though its rows are
// gone. Worktrees and everything else §9.2 protects are not this job's to touch. An archived row
// keeps its events.id, so a batch written twice (a crash between the file and the delete) reads
// back without ambiguity.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { err, ok, type Clock, type Result } from "@bayon/core";
import {
  getLastBackup,
  listArchivableEvents,
  type ArchivableEvent,
  type Db,
} from "@bayon/db";
import { deleteArchivedEvents } from "@bayon/db/supervisor";
import { frmError } from "../lifecycle/errors.js";

/** Rows per archive file and per delete transaction (the repo doctrine's batch size). */
export const RETENTION_BATCH = 100;
export const DAY_MS = 86_400_000;

export interface RetentionOptions {
  readonly db: Db;
  readonly clock: Clock;
  /** archive/events under FRM_HOME. */
  readonly archiveDir: string;
  /** retention.events_days. */
  readonly eventsDays: number;
  /** retention.reasoning = 'keep': reasoning events are never archived. */
  readonly keepReasoning: boolean;
  readonly batch?: number;
}

export type RetentionOutcome =
  | { readonly ran: false; readonly reason: string }
  | {
      readonly ran: true;
      readonly archived: number;
      readonly files: readonly string[];
    };

export const startOfUtcDay = (at: number): number => at - (at % DAY_MS);

/** `20260914` for any time on 2026-09-14 UTC. */
const utcDay = (at: number): string =>
  new Date(at).toISOString().slice(0, 10).replaceAll("-", "");

/** Why retention may not run now, or null when today's backup succeeded. */
async function blockedBy(db: Db, now: number): Promise<Result<string | null>> {
  const last = await getLastBackup(db);
  if (!last.ok) return last;
  if (last.value === null) return ok("no backup has been taken yet");
  if (last.value.outcome !== "ok") return ok("the last backup attempt failed");
  return last.value.ended_at < startOfUtcDay(now)
    ? ok("no backup has succeeded today (UTC)")
    : ok(null);
}

/** Writes one batch: a private temp file, synced, renamed into place, the directory synced. */
function writeBatch(
  dir: string,
  rows: readonly ArchivableEvent[],
): Result<string> {
  const firstId = rows[0]?.id ?? 0;
  const lastId = rows.at(-1)?.id ?? 0;
  const path = join(dir, `events-${firstId}-${lastId}.jsonl.gz`);
  const staged = join(dir, `.events-${firstId}-${lastId}.jsonl.gz.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = gzipSync(
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const fd = openSync(staged, "w", 0o600);
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, path);
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return ok(path);
  } catch (e) {
    return err(
      frmError(
        "internal",
        `cannot archive events ${firstId}-${lastId} to ${path}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

/** Archives, then deletes, every eligible event: idempotent, so a second run finds nothing. */
export async function runRetention(
  o: RetentionOptions,
): Promise<Result<RetentionOutcome>> {
  const now = o.clock.now();
  const blocked = await blockedBy(o.db, now);
  if (!blocked.ok) return blocked;
  if (blocked.value !== null) return ok({ ran: false, reason: blocked.value });
  const dir = join(o.archiveDir, utcDay(now));
  const closedBefore = now - o.eventsDays * DAY_MS;
  const files: string[] = [];
  let archived = 0;
  let afterId = 0;
  for (;;) {
    const rows = await listArchivableEvents(o.db, {
      closedBefore,
      includeReasoning: !o.keepReasoning,
      afterId,
      limit: o.batch ?? RETENTION_BATCH,
    });
    if (!rows.ok) return rows;
    const last = rows.value.at(-1);
    if (last === undefined) break;
    const file = writeBatch(dir, rows.value);
    if (!file.ok) return file;
    const deleted = await deleteArchivedEvents(
      o.db,
      rows.value.map((row) => row.id),
    );
    if (!deleted.ok) return deleted;
    files.push(file.value);
    archived += deleted.value;
    afterId = last.id;
  }
  return ok({ ran: true, archived, files });
}
