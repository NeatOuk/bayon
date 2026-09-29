// Where a new raw-log segment may start (§9.4, M4 amendment): at or past every offset the database
// holds. A new record at a stored (session_id, runner_type, raw_offset) would be skipped as a
// duplicate, which silently loses it, so offsets are never reused.
import { ok, type Result } from "@bayon/core";
import { getMaxRawOffset, getSession, type Db } from "@bayon/db";

/**
 * The session's last committed offset. This is one past its highest stored raw_offset (a mapped
 * event's ordinal stays below its record's length, so that is still inside the record), or its
 * committed raw_segment_offset if that is further, so segments never move backwards. A healthy raw
 * log is at least this long; a shorter one lost bytes the database still points into.
 */
export async function committedEnd(
  db: Db,
  sessionId: string,
): Promise<Result<number>> {
  const session = await getSession(db, sessionId);
  if (!session.ok) return session;
  const max = await getMaxRawOffset(db, sessionId);
  if (!max.ok) return max;
  return ok(
    Math.max((max.value ?? -1) + 1, session.value.raw_segment_offset ?? 0),
  );
}
