import { err, newId, ok, type Result, type SessionState } from "@bayon/core";
import type { Insertable, Updateable } from "kysely";
import {
  all,
  first,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { casMiss, failure, orNotFound } from "../errors.js";
import type { SessionRow, SessionsTable } from "../schema.js";
import { WASTES_SESSION_SPEND, wasteSessionSpend } from "./spend.js";

/** The states v_fleet leaves out (§4.1); listLiveSessions uses the same predicate. */
export const ENDED_STATES = [
  "exited",
  "resumable",
  "handed_off",
] as const satisfies readonly SessionState[];

/** A new session. `id` defaults to a new ULID; the API mints one for session.spawn. */
export type NewSession = Omit<
  Insertable<SessionsTable>,
  "id" | "state" | "created_at"
> & {
  readonly id?: string;
};

/** Columns a state change may set too, raw_segment_offset included. */
export type SessionPatch = Omit<
  Updateable<SessionsTable>,
  "id" | "state" | "created_at"
>;

export interface SessionCas {
  readonly from: readonly SessionState[];
  readonly to: SessionState;
  readonly patch?: SessionPatch;
}

export function createSession(db: Db, s: NewSession): R<SessionRow> {
  return write(db, (ix) => {
    const now = ix.clock.now();
    return returningOne(
      ix,
      qb
        .insertInto("sessions")
        .values({
          ...s,
          id: s.id ?? newId(now),
          state: "pending",
          created_at: now,
        })
        .returningAll(),
    );
  });
}

/**
 * Compare-and-set: moves the session to `to` only if it is in one of `from`, applying `patch` in
 * the same statement. No match is `not_found` or `conflict`, decided in the same transaction.
 */
export async function updateSessionState(
  db: Db,
  id: string,
  cas: SessionCas,
): R<SessionRow> {
  return write(db, (ix) => casSession(ix, id, cas));
}

/**
 * updateSessionState's compare-and-set inside the caller's write transaction, so a supervisor
 * writer can move the session together with its own rows (the hand-off writers).
 */
export function casSession(
  ix: Internals,
  id: string,
  cas: SessionCas,
): Result<SessionRow> {
  if (cas.from.length === 0) {
    return err(failure("validation", "from must name at least one state"));
  }
  const row = first(
    ix,
    qb
      .updateTable("sessions")
      .set({ ...cas.patch, state: cas.to })
      .where("id", "=", id)
      .where("state", "in", cas.from)
      .returningAll(),
  );
  if (row !== undefined) {
    if (row.exit_reason === WASTES_SESSION_SPEND) wasteSessionSpend(ix, id);
    return ok(row);
  }
  const current = first(
    ix,
    qb.selectFrom("sessions").select("state").where("id", "=", id),
  );
  return casMiss(`session ${id}`, current, cas.from);
}

export async function getSession(db: Db, id: string): R<SessionRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("sessions").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `session ${id}`);
}

/** Sessions v_fleet shows, oldest first. */
export function listLiveSessions(db: Db): R<SessionRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("sessions")
        .selectAll()
        .where("state", "not in", ENDED_STATES)
        .orderBy("created_at")
        .orderBy("id"),
    ),
  );
}

/** Sessions in any of `states`, oldest first. */
export async function listSessionsInStates(
  db: Db,
  states: readonly SessionState[],
): R<SessionRow[]> {
  if (states.length === 0) return ok([]);
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("sessions")
        .selectAll()
        .where("state", "in", states)
        .orderBy("created_at")
        .orderBy("id"),
    ),
  );
}

/** Live sessions (not ENDED_STATES) holding `runnerSessionId`. Invariant 12 allows one. */
export function findLiveByRunnerSessionId(
  db: Db,
  runnerSessionId: string,
): R<SessionRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("sessions")
        .selectAll()
        .where("runner_session_id", "=", runnerSessionId)
        .where("state", "not in", ENDED_STATES)
        .orderBy("created_at")
        .orderBy("id"),
    ),
  );
}

/**
 * Live sessions (not ENDED_STATES) for `agentId`, oldest first. Used to keep a config-seeded
 * one-shot agent (e.g. the markdown exporter) to a single running session: a caller reads
 * this before spawning and reuses the first row it finds instead of starting a second one.
 */
export function findLiveByAgent(db: Db, agentId: string): R<SessionRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("sessions")
        .selectAll()
        .where("agent_id", "=", agentId)
        .where("state", "not in", ENDED_STATES)
        .orderBy("created_at")
        .orderBy("id"),
    ),
  );
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The live session (not ENDED_STATES) holding `tokenHash`, or null: the API's MCP auth. */
export function findLiveSessionByTokenHash(
  db: Db,
  tokenHash: string,
): R<SessionRow | null> {
  return read(
    db,
    (ix) =>
      first(
        ix,
        qb
          .selectFrom("sessions")
          .selectAll()
          .where("mcp_token_hash", "=", tokenHash)
          .where("state", "not in", ENDED_STATES),
      ) ?? null,
  );
}

/**
 * Adopt's re-mint: a live session's new token hash, committed before its
 * process starts, so the runner's first MCP call already finds it. The old token dies here.
 */
export async function setSessionTokenHash(
  db: Db,
  id: string,
  tokenHash: string,
): R<void> {
  if (!SHA256_HEX.test(tokenHash)) {
    return err(
      failure("validation", "a token hash is 64 lowercase hex characters"),
    );
  }
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("sessions")
        .set({ mcp_token_hash: tokenHash })
        .where("id", "=", id)
        .where("state", "not in", ENDED_STATES)
        .returning("id"),
    );
    return row === undefined
      ? err(failure("not_found", `live session ${id}`))
      : ok(undefined);
  });
}

/** The inputs a pending session pins (§8.1) that a re-admission may re-pin. */
export interface PendingPins {
  readonly config_hash: string;
  readonly toolset_hash: string | null;
  readonly model: string | null;
  readonly model_tier: string | null;
  readonly effort: string | null;
  readonly mission_hash: string | null;
  /** 049: the context ruleset it spawns with, or null: re-resolved like the rest. */
  readonly context_ruleset: string | null;
}

/**
 * Re-admission's re-pin: a session still `pending` takes the inputs
 * its re-resolve found, so the waiter starts on what its row now pins; never its identity (runner,
 * executor, workspace). A compare-and-set on state='pending'; anything else is `conflict`.
 */
export async function repinPendingSession(
  db: Db,
  id: string,
  pins: PendingPins,
): R<SessionRow> {
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("sessions")
        .set({ ...pins })
        .where("id", "=", id)
        .where("state", "=", "pending")
        .returningAll(),
    );
    return row === undefined
      ? err(failure("conflict", `session ${id} is not pending`))
      : ok(row);
  });
}

/**
 * Clears attach leases that expired before now (§9.6 step 5); returns how many it cleared.
 * `human_attached` rows are excluded: `expireAttachLeases` (lifecycle/attach.ts) owns detaching
 * them properly (kill the tmux session, re-adopt, ask for a hand-off note) — a blind clear racing
 * ahead of that could null the lease column before `recordAttachRelease` reads it as the audit
 * correlation token.
 */
export function releaseExpiredLeases(db: Db): R<number> {
  return write(db, (ix) =>
    ok(
      all(
        ix,
        qb
          .updateTable("sessions")
          .set({ attach_lease_owner: null, attach_lease_expires_at: null })
          .where("attach_lease_expires_at", "<", ix.clock.now())
          .where("state", "!=", "human_attached")
          .returning("id"),
      ).length,
    ),
  );
}

/**
 * Renews `id`'s attach lease by `leaseMs` from now (§12.5's heartbeat renewal), only while it is
 * still held by `owner` and the session is still `human_attached` — a stale or already-released
 * heartbeat (a slow browser frame arriving after detach) must never resurrect a cleared lease.
 * Supervisor-only (Invariant 5: the API never writes `sessions`); the pty channel forwards a
 * heartbeat frame here rather than the API writing the row itself.
 */
export function renewAttachLease(
  db: Db,
  id: string,
  owner: string,
  leaseMs: number,
): R<boolean> {
  return write(db, (ix) =>
    ok(
      all(
        ix,
        qb
          .updateTable("sessions")
          .set({ attach_lease_expires_at: ix.clock.now() + leaseMs })
          .where("id", "=", id)
          .where("attach_lease_owner", "=", owner)
          .where("state", "=", "human_attached")
          .returning("id"),
      ).length > 0,
    ),
  );
}
