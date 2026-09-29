// What the worktree sweep needs of the supervisor: the database, the clock,
// host git, the mirror mutexes and which sessions this supervisor still owns. Never a session
// queue, the watchdog's queue or the admission drain: the sweep waits on none of them.
import type { SweepRow } from "@bayon/core";
import type { Db, SweepWorktree, WorkspaceRepo } from "@bayon/db";
import type { Log } from "../context.js";
import type { SecretStore } from "../secrets.js";
import type { HostGitCtx } from "../host-git.js";
import type { KeyedQueue } from "../session-queue.js";
import type { SweepSettings } from "./settings.js";

/** Test seams (as admission's hooks): each runs at its step, awaited. */
export interface SweepHooks {
  /** Inside the mirror mutex, before phase B's re-checks: a test writes a file here. */
  readonly beforeRecheck?: (row: SweepWorktree) => Promise<void> | void;
  /** After the HEAD/refs re-check, before B15's last emptiness check and `git worktree remove`. */
  readonly beforeRemove?: (row: SweepWorktree) => Promise<void> | void;
  /** After one module checkout is emptied (B12), before the next. */
  readonly afterModuleEmptied?: (checkout: string) => Promise<void> | void;
}

export interface SweepDeps extends HostGitCtx {
  readonly db: Db;
  readonly log: Log;
  /** $FRM_HOME: work/ must exist, or the pass aborts (M3); archive/worktrees takes bundles. */
  readonly frmHome: string;
  /** The per-mirror mutexes (ctx.mirrors): one held at a time, one row per hold. */
  readonly mirrors: KeyedQueue;
  /** The sessions this supervisor still owns something of (ctx.live). */
  readonly liveIds: () => ReadonlySet<string>;
  /** The host secret store: the forge token a base fetch from a private origin needs. */
  readonly secrets: SecretStore;
  readonly hooks?: SweepHooks;
}

/** One pass's reads, shared by its rows. */
export interface PassState {
  readonly now: number;
  readonly settings: SweepSettings;
  readonly signal: AbortSignal;
  /** Repos whose base this pass fetched (once per repo per pass, Q1). */
  readonly fetched: Set<string>;
  /** Mirror path → shallow (L3). */
  readonly shallow: Map<string, boolean>;
  /** Workspace id → its repos, for a submodule's child mirror. */
  readonly repos: Map<string, readonly WorkspaceRepo[]>;
}

/** What core's §3 rules read of a row. */
export const rowFacts = (row: SweepWorktree): SweepRow => ({
  executorKind: row.executor_kind,
  holderId: row.session_id,
  holderState: row.holder_state,
  holderEndedAt: row.holder_ended_at,
  holderGateId: row.holder_gate_id,
  ticketId: row.ticket_id,
  ticketStatus: row.ticket_status,
  unacceptedHandoff: row.unaccepted_handoff,
  liveSuccessor: row.live_successor,
});
