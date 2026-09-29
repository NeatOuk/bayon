// The session FSM (spec §3.3; an earlier change design §2, M0-reachable states) as one table: every edge
// the lifecycle takes, by name. An edge is a compare-and-set from its from-set; a `conflict`
// means another op moved the session first, and the caller re-reads and ends, never retries
// blindly (design §1). Edge 1 (∅ → pending) is the insert in resolve.ts, not a move.
import type { Result, SessionState } from "@bayon/core";
import type { Db, SessionRow } from "@bayon/db";
import { updateSessionState, type SessionPatch } from "@bayon/db/supervisor";

export interface Edge {
  /** Its row in design §2. */
  readonly n: number;
  readonly from: readonly SessionState[];
  readonly to: SessionState;
}

export const EDGES = {
  /** The executor is healthy and a slot granted. */
  admit: { n: 2, from: ["pending"], to: "preparing" },
  /** Worktree and home are ready. */
  prepare: { n: 3, from: ["preparing"], to: "spawning" },
  /** adapter.spawn succeeded and the segment began. */
  spawn: { n: 4, from: ["spawning"], to: "idle" },
  /** Run 1, from the spawn prompt. */
  startRun: { n: 5, from: ["idle"], to: "running" },
  /** The open run's first terminal; or it never started, or its process died. */
  endRun: { n: 6, from: ["running"], to: "idle" },
  /** session.stop, or the run timer fired. Out of handoff_writing it is the seal. */
  stop: { n: 7, from: ["running", "idle", "handoff_writing"], to: "stopping" },
  /** The process exited. */
  exit: { n: 8, from: ["stopping"], to: "exited" },
  /** A graceful stop of a resumable runner. */
  suspend: { n: 9, from: ["stopping"], to: "resumable" },
  /** Dead and adoptable: adopted via resume. */
  adopt: { n: 10, from: ["running", "idle"], to: "idle" },
  /** Dead and not adoptable; or, stopped, its process already gone. A death in
   * handoff_writing is never adopted: it gets its degraded packet. */
  die: { n: 11, from: ["running", "idle", "handoff_writing"], to: "exited" },
  /** Admission refused, a step failed, stopped, or orphaned at boot. */
  abort: { n: 12, from: ["pending", "preparing", "spawning"], to: "exited" },
  /** At boot: a stop was in flight and the process is dead. */
  reap: { n: 13, from: ["stopping"], to: "exited" },
  /** A hand-off starts (§7.1): its `writing` row commits with this edge. */
  beginHandoff: {
    n: 14,
    from: ["running", "idle"],
    to: "handoff_writing",
  },
  /** The seal, judgement in and nothing failed: the packet is full (§7.2). */
  handOff: { n: 15, from: ["handoff_writing"], to: "handed_off" },
  /** The seal otherwise: no handoff_write, or the run failed or hit a cap → abandoned. */
  handoffFail: { n: 16, from: ["handoff_writing"], to: "exited" },
  /** Admission keeps the session queued: its queued_reason changes, never its state. */
  queue: { n: 17, from: ["pending"], to: "pending" },
  /**
   * The reconciler only: a spawn the supervisor's restart cut short, `interrupted`. Unlike `abort`
   * it is hooked, so a holding session leaves its degraded hand-off.
   */
  restartAbort: {
    n: 18,
    from: ["pending", "preparing", "spawning"],
    to: "exited",
  },
  /** session.attach (§12.5): an operator takes the attach lease. */
  attach: { n: 19, from: ["running", "idle"], to: "human_attached" },
  /** DELETE .../attach, or TTL expiry: the lease is released. */
  release: { n: 20, from: ["human_attached"], to: "idle" },
  /**
   * The operator gives up on ever resuming a suspended session. Resumability is
   * deliberately protected — no stop edge leaves `resumable` — so this is the one decisive way
   * out, and the only thing that lets the sweep have its worktree back.
   */
  discard: { n: 21, from: ["resumable"], to: "exited" },
} as const satisfies Record<string, Edge>;

export type EdgeName = keyof typeof EDGES;

/** The edges after which the session has no process in this supervisor. */
export type EndEdge = {
  [K in EdgeName]: (typeof EDGES)[K]["to"] extends
    "exited" | "resumable" | "handed_off"
    ? K
    : never;
}[EdgeName];

/** Takes `edge` as one compare-and-set, applying `patch` in the same statement. */
export function fire(
  db: Db,
  id: string,
  edge: EdgeName,
  patch?: SessionPatch,
): Promise<Result<SessionRow>> {
  const { from, to }: Edge = EDGES[edge];
  return updateSessionState(db, id, { from, to, patch });
}
