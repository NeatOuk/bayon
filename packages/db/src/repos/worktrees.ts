import { SubmoduleShas, err, newId, ok, type SessionState } from "@bayon/core";
import type { Insertable } from "kysely";
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
import { failure } from "../errors.js";
import type { WorktreeRow, WorktreeState, WorktreesTable } from "../schema.js";
import { ENDED_STATES } from "./sessions.js";

/** A merged or removed worktree's directory is done with (§9.2): nobody takes it over. */
const GONE: readonly WorktreeState[] = ["merged", "removed"];

/** A new worktree row (§9.2). `id` defaults to a new ULID. */
export type NewWorktree = Omit<
  Insertable<WorktreesTable>,
  "id" | "created_at"
> & { readonly id?: string };

export function insertWorktree(db: Db, w: NewWorktree): R<WorktreeRow> {
  return write(db, (ix) => {
    const now = ix.clock.now();
    return returningOne(
      ix,
      qb
        .insertInto("worktrees")
        .values({ ...w, id: w.id ?? newId(now), created_at: now })
        .returningAll(),
    );
  });
}

/** Moves a worktree to `state`, stamping last_used_at. The directory itself is never touched. */
export function setWorktreeState(
  db: Db,
  id: string,
  state: WorktreeState,
): R<WorktreeRow> {
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("worktrees")
        .set({ state, last_used_at: ix.clock.now() })
        .where("id", "=", id)
        .returningAll(),
    );
    return row === undefined
      ? err(failure("not_found", `worktree ${id} does not exist`))
      : ok(row);
  });
}

/**
 * How many worktree rows a hand-off's chain has ever had, merged and removed included: the same
 * chain as listHandoffWorktrees. Zero means the holder never had a worktree, so its successor is
 * placed afresh; rows that are only merged or removed still refuse.
 */
export function countHandoffWorktreeRows(
  db: Db,
  h: { readonly id: string; readonly from_session_id: string },
): R<number> {
  return read(
    db,
    (ix) =>
      first(
        ix,
        qb
          .selectFrom("worktrees")
          .innerJoin("sessions", "sessions.id", "worktrees.session_id")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where((eb) =>
            eb.or([
              eb("worktrees.session_id", "=", h.from_session_id),
              eb("sessions.handoff_in_id", "=", h.id),
            ]),
          ),
      )?.n ?? 0,
  );
}

/** A worktree with the session holding it. */
export type HeldWorktree = WorktreeRow & {
  readonly holder_id: string;
  readonly holder_state: SessionState;
  readonly holder_executor_id: string;
};

/**
 * The worktrees a hand-off's chain holds (M2-c, plan rule 3): its from-session's, or those of a
 * successor spawned for it that never accepted, so the hand-off is still pending. Merged and
 * removed ones are left out; each comes with its holder's state and executor.
 */
export function listHandoffWorktrees(
  db: Db,
  h: { readonly id: string; readonly from_session_id: string },
): R<HeldWorktree[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("worktrees")
        .innerJoin("sessions", "sessions.id", "worktrees.session_id")
        .selectAll("worktrees")
        .select([
          "sessions.id as holder_id",
          "sessions.state as holder_state",
          "sessions.executor_id as holder_executor_id",
        ])
        .where((eb) =>
          eb.or([
            eb("worktrees.session_id", "=", h.from_session_id),
            eb("sessions.handoff_in_id", "=", h.id),
          ]),
        )
        .where("worktrees.state", "not in", GONE)
        .orderBy("worktrees.created_at")
        .orderBy("worktrees.id"),
    ),
  );
}

export interface WorktreeReassign {
  readonly id: string;
  /** The session holding it now, which must have ended. */
  readonly from_session_id: string;
  readonly to_session_id: string;
}

/** The compare-and-set that moves one worktree row; undefined when it may not move. */
function moveOne(ix: Internals, r: WorktreeReassign): WorktreeRow | undefined {
  return first(
    ix,
    qb
      .updateTable("worktrees")
      .set({
        session_id: r.to_session_id,
        state: "active",
        last_used_at: ix.clock.now(),
        // A live session owns it again: the sweep's flag no longer applies.
        kept_reason: null,
        kept_detail: null,
      })
      .where("id", "=", r.id)
      .where("session_id", "=", r.from_session_id)
      .where("state", "not in", GONE)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("sessions")
            .select("sessions.id")
            .where("sessions.id", "=", r.from_session_id)
            .where("sessions.state", "in", ENDED_STATES),
        ),
      )
      .returningAll(),
  );
}

const notYours = (r: WorktreeReassign) =>
  failure(
    "conflict",
    `worktree ${r.id} is not ${r.from_session_id}'s to hand over: taken, gone, or its holder is live`,
  );

/**
 * Hands a worktree to a successor (M2-c; §9.2: one session in a worktree at a time), in one
 * compare-and-set: only while `from` still holds it, `from` has ended, and it is neither merged
 * nor removed. The row itself moves, since a path has one row (§4 `path UNIQUE`); the successor's
 * predecessor_session_id keeps the chain. Git and the directory are never touched.
 */
export function reassignWorktree(db: Db, r: WorktreeReassign): R<WorktreeRow> {
  return write(db, (ix) => {
    const row = moveOne(ix, r);
    return row === undefined ? err(notYours(r)) : ok(row);
  });
}

export interface WorktreesReassign {
  /** One worktree per repo of the hand-off's chain. */
  readonly ids: readonly string[];
  readonly from_session_id: string;
  readonly to_session_id: string;
}

/**
 * reassignWorktree for every worktree a multi-repo hand-off holds, in one write transaction: all
 * move, or none does (a row that may not move rolls the others back).
 */
export function reassignWorktrees(
  db: Db,
  r: WorktreesReassign,
): R<WorktreeRow[]> {
  return write(db, (ix) => {
    const moved: WorktreeRow[] = [];
    for (const id of r.ids) {
      const one = { ...r, id };
      const row = moveOne(ix, one);
      if (row === undefined) return err(notYours(one));
      moved.push(row);
    }
    return ok(moved);
  });
}

/**
 * A submodule workspace's start SHAs on its superproject's row, checked
 * against SubmoduleShas before they are written.
 */
export async function setWorktreeSubmodules(
  db: Db,
  id: string,
  shas: SubmoduleShas,
): R<WorktreeRow> {
  const parsed = SubmoduleShas.safeParse(shas);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `worktree ${id}: submodule SHAs do not parse: ${parsed.error.message}`,
      ),
    );
  }
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("worktrees")
        .set({ submodule_shas_json: JSON.stringify(parsed.data) })
        .where("id", "=", id)
        .returningAll(),
    );
    return row === undefined
      ? err(failure("not_found", `worktree ${id} does not exist`))
      : ok(row);
  });
}

/** A session's worktrees, oldest first. */
export function listSessionWorktrees(
  db: Db,
  sessionId: string,
): R<WorktreeRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("worktrees")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("created_at")
        .orderBy("id"),
    ),
  );
}
