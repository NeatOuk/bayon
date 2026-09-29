import type {
  Clock,
  ForgeRemote,
  Result,
  SessionState,
  UsageTally,
} from "@bayon/core";
import {
  listSessionWorktrees,
  type Db,
  type RunRow,
  type SessionRow,
} from "@bayon/db";
import { setWorktreeState, type SessionPatch } from "@bayon/db/supervisor";
import type { Executor, PtyProc, Slot, SlotCounter } from "@bayon/executors";
import type { RunnerAdapter, SessionHandle } from "@bayon/runners";
import type { Admission, AdmissionHooks } from "./admission.js";
import type { AfterExit } from "./after-exit.js";
import { fire, type EdgeName } from "./fsm.js";
import type { CommandRequeue } from "../commands/claimer.js";
import type { ReleaseCandidates } from "../watchdog/candidates.js";
import type { Watchdog } from "../watchdog/watchdog.js";
import type { Ingest } from "./ports.js";
import type { RemotePolicy } from "./remote-policy.js";
import type { SecretStore } from "./secrets.js";
import type { KeyedQueue } from "./session-queue.js";
import type { LifecycleSettings } from "./settings.js";
import type { SweepHooks } from "./sweep/deps.js";
import type { ChannelSink, RelayServer } from "../relay.js";

/** pino's call shape, so the supervisor's logger drops in. */
export interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ExecutorSlots {
  readonly executor: Executor;
  readonly slots: SlotCounter;
}

export interface LifecycleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Log;
  /** $FRM_HOME: runtime/ and work/ live under it. */
  readonly frmHome: string;
  /** Executor id → the executor and its slots (§9.1 admission). */
  readonly executors: ReadonlyMap<string, ExecutorSlots>;
  /** Every executor its rows name, loaded at boot before the first reconciler
   * pass; it replaces `executors`. Absent: `executors` alone. */
  readonly loadExecutors?: (
    db: Db,
  ) => Promise<Result<ReadonlyMap<string, ExecutorSlots>>>;
  /** Runner id → adapter, from the runners registry: no runner names here (Invariant 1). */
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
  readonly ingest: Ingest;
  readonly secrets: SecretStore;
  /**
   * What a repo URL's host resolves to, for the remote policy. Default: DNS. Tests pass
   * one that touches no network.
   */
  readonly resolveHost?: (host: string) => Promise<readonly string[]>;
  /** The transports a remote read may use. Default: https and ssh; tests add `file`. */
  readonly remoteProtocols?: readonly string[];
  /** PATH for runner and git processes. Default: the supervisor's own. */
  readonly path?: string;
  /** The API's MCP endpoint a session's runner calls. */
  readonly mcpUrl?: string;
  /** Whether that endpoint answers: checked before an MCP spawn, since the CLI connects at init. */
  readonly mcpReachable?: (url: string) => Promise<boolean>;
  /** The claimer's requeue, for the periodic pass's command step. */
  readonly commands?: CommandRequeue;
  /**
   * FRM_HOME_TAG (paths.ts homeTag), as main.ts computed it for this home; given, the boot also
   * self-checks each local executor's orphan scan. Default: computed from frmHome.
   */
  readonly homeTag?: string;
  /**
   * The runners this daemon registers for its own jobs (main.ts): exempt from admission's
   * `uncertified` gate only, never a registry runner. Default: none.
   */
  readonly jobRunners?: ReadonlySet<string>;
  /** Tests only: seams inside the admission drain (admission.ts AdmissionHooks). */
  readonly admissionHooks?: AdmissionHooks;
  /** The supervisor's own disk, for the watchdog. Default: FRM_HOME/runtime and the
   * database's directory. */
  readonly diskPaths?: readonly string[];
  /** Free % of the filesystem holding `path` (tests). Default: statfs. */
  readonly freePct?: (path: string) => Promise<number | null>;
  /** single-flight early retention; absent, the low-disk rule only logs. */
  readonly retentionNow?: (reason: string) => Promise<void>;
  /**
   * The worktree sweep's own loop: given, boot() starts it after the boot
   * reconciler pass; main.ts gives it. Absent (most test worlds), only sweepWorktrees() runs a pass.
   */
  readonly sweep?: { readonly hooks?: SweepHooks };
  /**
   * `fetch` for the forge client: tests point it at a local fixture server. Absent, the
   * delivery job uses the platform's own.
   */
  readonly forgeFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Tests only: which forge a recorded remote is on, in place of core's `forgeRemote`. A test's
   * remotes are local bare repositories, which have no forge host at all, so this is what lets one
   * exercise the pull-request half against a local HTTP fixture while git still pushes locally.
   * Production passes nothing and gets `forgeRemote`.
   */
  readonly forgeRemoteOf?: (url: string) => ForgeRemote | null;
  /** The relay server (§12.5): register a session's pty on it so the API can stream it
   * over its own session:<id>:pty. Absent in most test worlds; attach then skips pty streaming. */
  readonly relay?: RelayServer;
}

/** `budget`: a hard cap stopped it (ceilings.ts). */
export type StopIntent = "graceful" | "kill" | "timeout" | "budget";

export interface LiveProcess {
  readonly handle: SessionHandle;
  readonly adapter: RunnerAdapter;
  readonly executor: Executor;
  /** Settles once ingest has read the process to EOF and closed any run it left open. */
  readonly closed: Promise<unknown>;
  /** The secret values its env held, as ingest redacts them (attachProcess): a takeover of it keeps
   * them out of the pty log too, since /mcp still takes its token and the resumed CLI can print the
   * token back from its own history (FRM-123). */
  readonly redact?: readonly string[];
  /** When ingest read it to EOF, on the lifecycle clock; null before (attachProcess). */
  readonly eofAt?: () => number | null;
}

export interface RunTimer {
  readonly runId: string;
  readonly cancel: AbortController;
  /** Set when the run started outside idle: its end leaves the session state to its caller. */
  readonly within?: SessionState;
  /** RunRequest.onEnded: told once the run has ended, by its terminal or its wall clock. */
  readonly onEnded?: (run: RunRow) => void;
}

/** What this supervisor owns of one session. */
export interface Entry {
  /** Aborts the spawn pipeline: the slot wait, git, the spawn. */
  readonly abort: AbortController;
  readonly intent?: StopIntent;
  readonly slot?: Slot;
  readonly proc?: LiveProcess;
  readonly timer?: RunTimer;
  /** Its process died under this supervisor; the slot stays held until the reconciler acts. */
  readonly dead: boolean;
  /**
   * A dead entry's process when a periodic pass declared the exit missed: the exit op
   * still queued for it finishes the teardown — its group kill and afterExit — from here.
   */
  readonly missed?: LiveProcess;
  /** A hand-off being written. */
  readonly handoff?: HandoffEntry;
  /** A ceiling check is queued: ceilings.ts coalesces commit notices into one. */
  readonly ceilingCheck?: boolean;
  /** The session's turn_end usage folded so far (ceilings.ts); a fresh entry re-reads it. */
  readonly tally?: UsageTally;
  /** A soft ceiling has asked for the hand-off: it asks once (§7.1). */
  readonly handoffAsked?: boolean;
  /** The run class's context cap was clamped to the model's window, and said so once. */
  readonly windowClampWarned?: boolean;
  /**
   * A hand-off asked for while a run was open, deferred to that run's end: a phase
   * change is not an emergency, and interrupting the turn costs the commit or the note the agent
   * still had to write. `onRunEnded` takes it, once, after the run's end edge. A closure rather
   * than data so run.ts needs no import of handoff.ts.
   */
  readonly deferredHandoff?: (() => Promise<void>) | undefined;
  /**
   * A "take over after this step" waiting for the open run's end. The in-memory fast
   * path of `sessions.attach_intent_*`, which is the record: the terminal's queue op takes it once
   * (attach-intent.ts), and the reconciler's sweep re-arms it from the row when an adopt or a
   * restart dropped it.
   */
  readonly attachIntent?: AttachIntentEntry | undefined;
}

/** Who asked to take over after the open run, and when. */
export interface AttachIntentEntry {
  /** Becomes `attach_lease_owner` when the attach happens. */
  readonly owner: string;
  readonly requestedAt: number;
}

/** The session's `writing` row, and whether its handoff run went over a cap. */
export interface HandoffEntry {
  readonly handoffId: string;
  readonly capHit: boolean;
}

/** A session's last edge committed: what the pulse scheduler hears. */
export interface SessionEnded {
  readonly sessionId: string;
  /** Its ticket: only a ticket session's end is a completion (a pulse's own session has none). */
  readonly ticketId: string | null;
  /**
   * The session's project (`sessions.workspace_id`): a ticket session is spawned in its ticket's
   * project — staffing pins a ticket with none to its agent's first — so it is whose orchestrators
   * the end wakes. Null: none.
   */
  readonly workspaceId: string | null;
  readonly at: number;
  /**
   * This end left a hand-off pending, which onHandoffPending already announced: that
   * announcement is the completion, so the end is not a second one.
   */
  readonly handoffPending: boolean;
}

/** A hand-off became pending: a completion wake (§9.7; design §3 (b)). */
export interface HandoffPending {
  readonly handoffId: string;
  readonly ticketId: string;
  /** The project of the session that left it, as SessionEnded's. */
  readonly workspaceId: string | null;
  /** `full` or `degraded`: a row still `writing` is never announced. */
  readonly quality: string;
  readonly at: number;
}

/** A session's tmux pty, live under this process's pty(), and the relay channel streaming it
 * (§12.5 point 3). Present only while attached and its channel is registered. */
export interface PtyChannelEntry {
  readonly pty: PtyProc;
  readonly sink: ChannelSink;
}

export interface Ctx extends LifecycleDeps {
  readonly settings: LifecycleSettings;
  /** What a remote read (the repo check, a first clone) may reach. */
  readonly remote: RemotePolicy;
  readonly path: string;
  readonly mcpUrl: string;
  readonly mcpReachable: (url: string) => Promise<boolean>;
  readonly live: Map<string, Entry>;
  readonly queue: KeyedQueue;
  readonly mirrors: KeyedQueue;
  /** Adopts per session by this process, capped by lifecycle.adopt_max. */
  readonly adopts: Map<string, number>;
  /** Told after a session's last edge commits (Lifecycle.onSessionEnded). */
  readonly ended: Set<(e: SessionEnded) => void>;
  /** Told when a hand-off becomes pending (Lifecycle.onHandoffPending). */
  readonly pending: Set<(e: HandoffPending) => void>;
  /** InternalSpawn.afterExit by session: taken once its process closes, dropped at its end. */
  readonly afterExit: Map<string, AfterExit>;
  /** This supervisor's FRM_HOME_TAG, stamped into every session's env. */
  readonly homeTag: string;
  /** The boot self-check of each local executor's orphan scan, kept in its health_detail. */
  readonly orphanScan: Map<string, "ok" | "unavailable">;
  readonly jobRunners: ReadonlySet<string>;
  /** Queued spawns and their drain, off the session queues. */
  readonly admission: Admission;
  /**
   * The sessions this process spawned, re-admitted, or attached a process to (   * §5.1): in memory, so a restart empties it. Outside it, what the reconciler ends is the
   * restart's, and says so (`supervisor_restart`).
   */
  readonly owned: Set<string>;
  /** Every process an adapter handed back, until nothing more can come from it. */
  readonly candidates: ReleaseCandidates;
  /** The watchdog: step 8 of each reconciler pass. Absent where a test builds a Ctx by hand. */
  readonly watchdog?: Watchdog;
  /** A session's tmux pty and its relay channel, by session id, while attached. */
  readonly ptyChannels: Map<string, PtyChannelEntry>;
}

export const SPAWN_STATES = [
  "pending",
  "preparing",
  "spawning",
] as const satisfies readonly SessionState[];
/** States with a runner process (§2: resumable and exited have none). */
export const PROCESS_STATES = [
  "running",
  "idle",
  "stopping",
  "handoff_writing",
] as const satisfies readonly SessionState[];

export const isIn = <S extends SessionState>(
  states: readonly S[],
  state: SessionState,
): state is S => (states as readonly SessionState[]).includes(state);

/** Replaces a live entry with a patched copy; no entry, no change. */
export function patchEntry(ctx: Ctx, id: string, patch: Partial<Entry>): void {
  const entry = ctx.live.get(id);
  if (entry !== undefined) ctx.live.set(id, { ...entry, ...patch });
}

/** Queues `op` on the session; a failure is logged, never thrown at the caller. */
export function schedule(
  ctx: Ctx,
  id: string,
  what: string,
  op: () => Promise<void>,
): void {
  ctx.queue.run(id, op).catch((e: unknown) => {
    ctx.log.error({ sessionId: id, err: String(e) }, `${what} failed`);
  });
}

/** One §2 edge (fsm.ts): a compare-and-set from its from-set. */
export const move = (
  ctx: Ctx,
  id: string,
  edge: EdgeName,
  patch?: SessionPatch,
): Promise<Result<SessionRow>> => fire(ctx.db, id, edge, patch);

/**
 * Tells every onSessionEnded listener that `s` has ended (end.ts calls it once the last edge has
 * committed); one that throws is logged and never stops the others.
 */
export function announceEnd(
  ctx: Ctx,
  s: SessionRow,
  handoffPending = false,
): void {
  // A session that ended without a process never ran its hook: drop it with the session.
  ctx.afterExit.delete(s.id);
  const e: SessionEnded = {
    sessionId: s.id,
    ticketId: s.ticket_id,
    workspaceId: s.workspace_id,
    at: s.ended_at ?? ctx.clock.now(),
    handoffPending,
  };
  for (const fn of ctx.ended) {
    try {
      fn(e);
    } catch (thrown) {
      ctx.log.error(
        { sessionId: s.id, err: String(thrown) },
        "an onSessionEnded listener threw",
      );
    }
  }
}

/**
 * Tells every onHandoffPending listener that hand-off `row` is takeable: finalized full or
 * degraded, its packet file written. A `writing` row is never announced; a listener that throws
 * is logged and never stops the others.
 */
export function announceHandoffPending(
  ctx: Ctx,
  row: {
    readonly id: string;
    readonly ticket_id: string;
    readonly quality: string;
  },
  /** The session that left it: its project is the hand-off's. */
  from: Pick<SessionRow, "workspace_id">,
): void {
  if (row.quality === "writing") return;
  const e: HandoffPending = {
    handoffId: row.id,
    ticketId: row.ticket_id,
    workspaceId: from.workspace_id,
    quality: row.quality,
    at: ctx.clock.now(),
  };
  for (const fn of ctx.pending) {
    try {
      fn(e);
    } catch (thrown) {
      ctx.log.error(
        { handoffId: row.id, err: String(thrown) },
        "an onHandoffPending listener threw",
      );
    }
  }
}

/** Lets go of what this supervisor holds of a session, its timer and slot, leaving its state. */
export function releaseEntry(ctx: Ctx, id: string): void {
  const entry = ctx.live.get(id);
  ctx.live.delete(id);
  entry?.timer?.cancel.abort();
  entry?.slot?.release();
}

/** Marks the session's active worktrees orphan. The directories stay (§9.2). */
export async function orphanWorktrees(ctx: Ctx, id: string): Promise<void> {
  const rows = await listSessionWorktrees(ctx.db, id);
  if (!rows.ok) {
    ctx.log.error(
      { sessionId: id, error: rows.error },
      "cannot list worktrees",
    );
    return;
  }
  for (const w of rows.value.filter((row) => row.state === "active")) {
    const moved = await setWorktreeState(ctx.db, w.id, "orphan");
    if (!moved.ok) {
      ctx.log.error({ sessionId: id, error: moved.error }, "cannot orphan");
    }
  }
}
