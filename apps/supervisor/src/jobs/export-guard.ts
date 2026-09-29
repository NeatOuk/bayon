// The single-exporter guard (design doc §6): both the interval timer and `POST /exports/run` call
// this instead of spawning directly, so the exporter agent is never running two sessions at once.
import { ok, type Result } from "@bayon/core";
import { findLiveByAgent, type Db } from "@bayon/db";

export interface SpawnExportOptions {
  readonly db: Db;
  readonly agentId: string;
  /** Starts a fresh session and resolves to its id. Called only when none is already live. */
  readonly spawn: () => Promise<Result<string>>;
}

/**
 * The exporter's live session id if one exists, else the id of a freshly spawned one. This is a
 * read, then maybe a spawn -- not one atomic step, so a genuine race between the timer and a
 * concurrent request is possible; the session row's own idempotency on `session_id` (edge 1: a
 * repeated id finds its row, nothing runs twice) is the real backstop, not this check alone
 * (design doc §10).
 */
export async function spawnExportIfIdle(
  o: SpawnExportOptions,
): Promise<Result<string>> {
  const live = await findLiveByAgent(o.db, o.agentId);
  if (!live.ok) return live;
  const first = live.value[0];
  return first === undefined ? o.spawn() : ok(first.id);
}
