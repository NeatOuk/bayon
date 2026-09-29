// The gate engine's state: what it tracks is a cache over the gate rows,
// which rule. A gate is `inFlight` from its claim until its reviewer is tracked or it is decided,
// so a claim, a retry and the poll never start one gate twice.
import {
  err,
  ok,
  type Clock,
  type Result,
  type SourceChanges,
} from "@bayon/core";
import type { Db } from "@bayon/db";
import type { Executor } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import { LOCAL_EXECUTOR_ID } from "../boot.js";
import { frmError } from "../lifecycle/errors.js";
import type { ExecCtx } from "../lifecycle/exec.js";
import type { Log } from "../lifecycle/index.js";
import type { SecretStore } from "../lifecycle/secrets.js";
import { KeyedQueue } from "../lifecycle/session-queue.js";
import {
  DEFAULT_SETTINGS,
  type LifecycleSettings,
} from "../lifecycle/settings.js";
import type { Lifecycle } from "../supervisor.js";
import type { GitCtx } from "./git.js";
import type { ReviewerChoice } from "./pick.js";
import type { Pin } from "./subject.js";

export interface GateEngineDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Log;
  readonly frmHome: string;
  readonly lifecycle: Pick<
    Lifecycle,
    "spawnInternal" | "stop" | "onSessionEnded"
  >;
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
  /** The executors git runs on: `local`, where the mirrors are, and every executor a builder's
   * worktree may sit on. */
  readonly executors: ReadonlyMap<string, Executor>;
  /** PATH for git. */
  readonly path: string;
  /** The host secret store: a private origin's forge token for the subject's fetch.
   * Omitting it silently means no forge token for private-origin fetches, not an error. */
  readonly secrets?: SecretStore;
}

/** A reviewer the engine spawned, by its session. */
export interface Track {
  readonly gateId: string;
  readonly kind: string;
  readonly sessionId: string;
  readonly deadline: number;
  readonly pin: Pin;
  readonly choice: ReviewerChoice;
  readonly baseDrift: boolean;
  readonly sourceChanges?: SourceChanges;
}

export interface GateCtx {
  readonly d: GateEngineDeps;
  readonly tracked: Map<string, Track>;
  /** gate id → its tracked reviewer's session id. */
  readonly byGate: Map<string, string>;
  readonly inFlight: Set<string>;
  /** Sessions whose afterExit took the decision: their end decides nothing. */
  readonly collected: Set<string>;
  /** Sessions a kill was asked for. */
  readonly stopping: Set<string>;
  readonly tasks: Set<Promise<void>>;
  /** git on one mirror at a time (fetch, worktree remove). */
  readonly mirrors: KeyedQueue;
  /** The lifecycle settings git's timeouts come from, reloaded by each poll. */
  readonly settings: { current: LifecycleSettings };
  /**
   * Set by stop(): a stopped engine starts and decides nothing more, so a reviewer whose process
   * ends after a shutdown is left running for the next boot's sweep (supervisor_restart, §9).
   */
  readonly state: { stopped: boolean };
}

export const createGateCtx = (d: GateEngineDeps): GateCtx => ({
  state: { stopped: false },
  d,
  tracked: new Map(),
  byGate: new Map(),
  inFlight: new Set(),
  collected: new Set(),
  stopping: new Set(),
  tasks: new Set(),
  mirrors: new KeyedQueue(),
  settings: { current: DEFAULT_SETTINGS },
});

/** Runs `p` in the background; a failure is logged, never thrown at anyone. */
export function background(ctx: GateCtx, what: string, p: Promise<void>): void {
  const task: Promise<void> = p
    .catch((e: unknown) => {
      ctx.d.log.error({ err: String(e) }, `${what} failed`);
    })
    .finally(() => {
      ctx.tasks.delete(task);
    });
  ctx.tasks.add(task);
}

export const execCtx = (ctx: GateCtx): ExecCtx => ({
  settings: ctx.settings.current,
  clock: ctx.d.clock,
  frmHome: ctx.d.frmHome,
  path: ctx.d.path,
  log: ctx.d.log,
});

/** git on the supervisor's own host: where the mirrors are, and every gate's diff. */
export const gitCtx = (ctx: GateCtx): Result<GitCtx> =>
  gitOn(ctx, LOCAL_EXECUTOR_ID);

/**
 * git on one executor: a worktree is read where it lives, since a container's is not on this host
 *. An executor the engine was not given cannot be reached at all — the gate says so
 * rather than running the command on the wrong host.
 */
export function gitOn(ctx: GateCtx, executorId: string): Result<GitCtx> {
  const executor = ctx.d.executors.get(executorId);
  return executor === undefined
    ? err(frmError("validation", `no ${executorId} executor for git`))
    : ok({ exec: execCtx(ctx), executor });
}

export function track(ctx: GateCtx, t: Track): void {
  ctx.tracked.set(t.sessionId, t);
  ctx.byGate.set(t.gateId, t.sessionId);
}

export function untrack(ctx: GateCtx, sessionId: string): Track | undefined {
  const t = ctx.tracked.get(sessionId);
  ctx.tracked.delete(sessionId);
  if (t !== undefined && ctx.byGate.get(t.gateId) === sessionId) {
    ctx.byGate.delete(t.gateId);
  }
  return t;
}

/** Asks for a reviewer's kill once. */
export function kill(ctx: GateCtx, sessionId: string): void {
  if (ctx.stopping.has(sessionId)) return;
  ctx.stopping.add(sessionId);
  background(
    ctx,
    `stop reviewer ${sessionId}`,
    ctx.d.lifecycle.stop(sessionId, "kill"),
  );
}

/** Settles once no background task is left. */
export async function settled(ctx: GateCtx): Promise<void> {
  while (ctx.tasks.size > 0) await Promise.allSettled([...ctx.tasks]);
}
