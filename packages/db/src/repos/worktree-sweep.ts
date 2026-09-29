// The worktree sweep's read and writers (§9.6 step 6, §9.2; the design §3, §9).
// worktrees is supervisor-owned (§9.5): the writers leave through @bayon/db/supervisor only. They
// write kept_reason and kept_detail, or move a row to `removed`, each a compare-and-set; never any
// other state, since the laws and the gates read worktrees.state as a fact (§2).
import {
  capDetail,
  err,
  ok,
  type SessionState,
  type WorktreeKeptReason,
} from "@bayon/core";
import { all, first, qb, read, write, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";
import type { WorktreeRow, WorktreeState } from "../schema.js";

/** Rows the sweep is done with: never listed. */
const GONE: readonly WorktreeState[] = ["merged", "removed"];

/** A successor in one of these has ended: it no longer holds its chain's worktrees (§3 rule 5). */
const SUCCESSOR_ENDED: readonly SessionState[] = ["exited", "handed_off"];

/** A worktree row with every fact the sweep's §3 decides on. */
export type SweepWorktree = WorktreeRow & {
  readonly holder_state: SessionState | null;
  readonly holder_ended_at: number | null;
  readonly holder_gate_id: string | null;
  /** The holder's executor's kind: only `local` rows are ever looked at (§8). */
  readonly executor_kind: string | null;
  readonly ticket_status: string | null;
  readonly mirror_path: string;
  readonly origin_url: string | null;
  readonly default_base_branch: string;
  /** An unaccepted hand-off from the holder, or the holder's own incoming one. */
  readonly unaccepted_handoff: boolean;
  /** A session spawned for such a hand-off that has not ended. */
  readonly live_successor: boolean;
};

function sweepQuery() {
  return qb
    .selectFrom("worktrees as wt")
    .innerJoin("repos as r", "r.id", "wt.repo_id")
    .leftJoin("sessions as s", "s.id", "wt.session_id")
    .leftJoin("executors as x", "x.id", "s.executor_id")
    .leftJoin("tickets as t", "t.id", "wt.ticket_id")
    .selectAll("wt")
    .select([
      "s.state as holder_state",
      "s.ended_at as holder_ended_at",
      "s.gate_id as holder_gate_id",
      "x.kind as executor_kind",
      "t.status as ticket_status",
      "r.mirror_path as mirror_path",
      "r.origin_url as origin_url",
      "r.default_base_branch as default_base_branch",
    ])
    .select((eb) => [
      eb
        .exists(
          eb
            .selectFrom("handoffs as h")
            .select("h.id")
            .where("h.accepted_at", "is", null)
            .where((w) =>
              w.or([
                w("h.from_session_id", "=", w.ref("wt.session_id")),
                w("h.id", "=", w.ref("s.handoff_in_id")),
              ]),
            ),
        )
        .as("unaccepted_handoff"),
      eb
        .exists(
          eb
            .selectFrom("handoffs as h2")
            .innerJoin("sessions as s2", "s2.handoff_in_id", "h2.id")
            .select("h2.id")
            .where("h2.accepted_at", "is", null)
            .where((w) =>
              w.or([
                w("h2.from_session_id", "=", w.ref("wt.session_id")),
                w("h2.id", "=", w.ref("s.handoff_in_id")),
              ]),
            )
            .where("s2.state", "not in", SUCCESSOR_ENDED),
        )
        .as("live_successor"),
    ]);
}

type Raw = Omit<SweepWorktree, "unaccepted_handoff" | "live_successor"> & {
  readonly unaccepted_handoff: unknown;
  readonly live_successor: unknown;
};

const toSweep = (row: Raw): SweepWorktree => ({
  ...row,
  unaccepted_handoff: Boolean(row.unaccepted_handoff),
  live_successor: Boolean(row.live_successor),
});

/** Every row not merged or removed, oldest first, with its holder, ticket and repo facts. */
export function listSweepWorktrees(db: Db): R<SweepWorktree[]> {
  return read(db, (ix) =>
    all(
      ix,
      sweepQuery()
        .where("wt.state", "not in", GONE)
        .orderBy("wt.created_at")
        .orderBy("wt.id"),
    ).map(toSweep),
  );
}

/**
 * Whether a worktree row ever existed, removed and merged ones included: the sweep makes a missing
 * $FRM_HOME/work only on an install that never had one (a fresh home), never on one that did.
 */
export async function everHadWorktree(db: Db): R<boolean> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("worktrees").select("id").limit(1)),
  );
  return found.ok ? ok(found.value !== undefined) : found;
}

/** One row, as listSweepWorktrees gives it: phase B's re-read (§4 check 1). Null when absent. */
export function getSweepWorktree(db: Db, id: string): R<SweepWorktree | null> {
  return read(db, (ix) => {
    const row = first(ix, sweepQuery().where("wt.id", "=", id));
    return row === undefined ? null : toSweep(row);
  });
}

/** The row as the sweep read it: its holder, and for a removal its state. */
export interface SweptRow {
  readonly id: string;
  readonly session_id: string | null;
}

const moved = (id: string) =>
  failure(
    "conflict",
    `worktree ${id} moved, or was removed, since the sweep read it`,
  );

function setFlag(
  db: Db,
  w: SweptRow,
  reason: WorktreeKeptReason | null,
  detail: string | null,
): R<WorktreeRow> {
  return write(db, (ix) => {
    const q = qb
      .updateTable("worktrees")
      .set({ kept_reason: reason, kept_detail: detail })
      .where("id", "=", w.id)
      .where("state", "!=", "removed");
    const held =
      w.session_id === null
        ? q.where("session_id", "is", null)
        : q.where("session_id", "=", w.session_id);
    const row = first(ix, held.returningAll());
    return row === undefined ? err(moved(w.id)) : ok(row);
  });
}

/**
 * Flags a kept worktree for a human (§9): kept_reason and kept_detail (capped), nothing else, and
 * only while the row is still the holder's and not removed.
 */
export function flagWorktree(
  db: Db,
  f: SweptRow & {
    readonly reason: WorktreeKeptReason;
    readonly detail: string | null;
  },
): R<WorktreeRow> {
  return setFlag(
    db,
    f,
    f.reason,
    f.detail === null ? null : capDetail(f.detail),
  );
}

/** Clears the sweep's flag: the row is clean again, or kept for nothing a human must decide. */
export function clearWorktreeFlag(db: Db, w: SweptRow): R<WorktreeRow> {
  return setFlag(db, w, null, null);
}

/**
 * The sweep's one state write (§6 B17): `removed`, flags cleared, only while the row is still in
 * `state` under the same holder, the compare-and-set against a hand-off moving it.
 */
export function markWorktreeRemoved(
  db: Db,
  r: SweptRow & { readonly state: WorktreeState },
): R<WorktreeRow> {
  return write(db, (ix) => {
    const q = qb
      .updateTable("worktrees")
      .set({
        state: "removed",
        kept_reason: null,
        kept_detail: null,
        last_used_at: ix.clock.now(),
      })
      .where("id", "=", r.id)
      .where("state", "=", r.state);
    const held =
      r.session_id === null
        ? q.where("session_id", "is", null)
        : q.where("session_id", "=", r.session_id);
    const row = first(ix, held.returningAll());
    return row === undefined ? err(moved(r.id)) : ok(row);
  });
}
