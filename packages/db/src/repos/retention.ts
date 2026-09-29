import { err, ok } from "@bayon/core";
import { z } from "zod";
import { all, qb, read, write, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";
import type { EventRow } from "../schema.js";

// Event retention (§4 retention, §13.2): the events of tickets closed more than
// retention.events_days ago are archived to gzipped JSONL by the supervisor's job, then deleted
// here, a batch per transaction. Only sessions ended for good are swept: 'resumable' is not, since
// a resume would begin a new raw-log segment and replay it. Raw logs stay on disk: they are the
// replay source, and a new segment starts past their size, so no offset is reused.

/** A ticket in one of these, with closed_at set, is closed (core's isTerminal). */
export const CLOSED_TICKET_STATUSES = ["done", "rejected"] as const;
/** Sessions whose events retention may archive. */
export const ARCHIVABLE_SESSION_STATES = ["exited", "handed_off"] as const;
/** At most this many rows per batch (the repo doctrine batches ingest at 100). */
export const MAX_RETENTION_BATCH = 1_000;

export const ArchivableQuery = z.object({
  /** Tickets closed strictly before this, epoch millis. */
  closedBefore: z.int().nonnegative(),
  /** Reasoning events too (retention.reasoning is not 'keep'). */
  includeReasoning: z.boolean(),
  /** Only events with a larger id: the caller's cursor through one sweep. */
  afterId: z.int().nonnegative(),
  limit: z.int().min(1).max(MAX_RETENTION_BATCH),
});
export type ArchivableQuery = z.infer<typeof ArchivableQuery>;

/** An event retention may archive, with its ticket. */
export type ArchivableEvent = EventRow & { readonly ticket_id: string };

/** The next batch of archivable events after `afterId`, in id order. */
export async function listArchivableEvents(
  db: Db,
  q: ArchivableQuery,
): R<ArchivableEvent[]> {
  const parsed = ArchivableQuery.safeParse(q);
  if (!parsed.success)
    return err(failure("validation", z.prettifyError(parsed.error)));
  const { closedBefore, includeReasoning, afterId, limit } = parsed.data;
  const rows = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("events as e")
        .innerJoin("sessions as s", "s.id", "e.session_id")
        .innerJoin("tickets as t", "t.id", "s.ticket_id")
        .selectAll("e")
        .select("t.id as ticket_id")
        .where("t.status", "in", CLOSED_TICKET_STATUSES)
        .where("t.closed_at", "is not", null)
        .where("t.closed_at", "<", closedBefore)
        .where("s.state", "in", ARCHIVABLE_SESSION_STATES)
        .where("e.id", ">", afterId)
        .$if(!includeReasoning, (w) => w.where("e.kind", "<>", "reasoning"))
        .orderBy("e.id")
        .limit(limit),
    ),
  );
  return rows.ok ? ok(rows.value) : rows;
}

/** Deletes archived events in one transaction; resolves to how many rows went. */
export async function deleteArchivedEvents(
  db: Db,
  ids: readonly number[],
): R<number> {
  if (ids.length === 0) return ok(0);
  if (
    ids.length > MAX_RETENTION_BATCH ||
    !ids.every((id) => Number.isInteger(id) && id > 0)
  ) {
    return err(
      failure(
        "validation",
        `a retention batch is 1 to ${MAX_RETENTION_BATCH} positive integer event ids`,
      ),
    );
  }
  return write(db, (ix) =>
    ok(
      all(ix, qb.deleteFrom("events").where("id", "in", ids).returning("id"))
        .length,
    ),
  );
}
