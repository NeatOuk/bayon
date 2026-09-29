// The session lifecycle: FSM §3.3, spawn pipeline §9.1, run timer, reconciler v0 §9.6.
// main.ts hands `lifecycleFactory` to startSupervisor: the handlers go on the claimer, and
// `boot()` (templates, settings, one reconciler pass) runs before the claimer starts.
import { dirname, join } from "node:path";
import process from "node:process";
import { TEMPLATES, ok, templateRecord, type Result } from "@bayon/core";
import { listExecutors, type RunRow } from "@bayon/db";
import { upsertPromptTemplates } from "@bayon/db/supervisor";
import { dbPath, homeTag } from "../paths.js";
import { ReleaseCandidates } from "../watchdog/candidates.js";
import {
  createWatchdog,
  type CircuitBreaker,
  type Watchdog,
} from "../watchdog/watchdog.js";
import type { LifecycleFactory } from "../supervisor.js";
import { createAdmission } from "./admission.js";
import { remotePolicy } from "./remote-policy.js";
import { takeAttachIntent } from "./attach-intent.js";
import { onCommitted } from "./ceilings.js";
import {
  commandHandlers,
  spawnSession,
  type LifecycleHandlers,
} from "./commands.js";
import {
  schedule,
  type Ctx,
  type ExecutorSlots,
  type HandoffPending,
  type LifecycleDeps,
  type SessionEnded,
} from "./context.js";
import { resizeSlots } from "./health.js";
import { spawnInternal, type InternalSpawn } from "./internal-spawn.js";
import { checkOrphanScans } from "./orphan-scan.js";
import { DEFAULT_MCP_URL, httpReachable } from "./mcp.js";
import type { SessionSpawnPayload, StopMode } from "./payloads.js";
import type { RunRequest } from "./prompt.js";
import { reapSession } from "./reaper.js";
import { reconcilePass, type PassPhase } from "./reconciler.js";
import { onRunEnded, startRun } from "./run.js";
import type { SecretStore } from "./secrets.js";
import { KeyedQueue } from "./session-queue.js";
import { runPipeline } from "./spawn.js";
import { requestStop } from "./stop.js";
import { createSweepLoop } from "./sweep/loop.js";
import { sweepPass, type SweepDeps } from "./sweep/sweep.js";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type LifecycleSettings,
} from "./settings.js";

export type { LifecycleHandlers } from "./commands.js";
export type {
  ExecutorSlots,
  HandoffPending,
  LifecycleDeps,
  Log,
  SessionEnded,
} from "./context.js";
export type { InternalSpawn, InternalWorkspace } from "./internal-spawn.js";
export type { AfterExit, AfterExitFacts } from "./after-exit.js";
export type { PinnedCheckout } from "./resolve.js";
export {
  SessionHandoffPayload,
  SessionInterruptPayload,
  SessionSpawnPayload,
  SessionStopPayload,
  StopMode,
} from "./payloads.js";
export { configInput, parseConfig, type SessionConfig } from "./profile.js";
export {
  outputFile,
  promptFile,
  sessionPaths,
  type SessionPaths,
} from "./paths.js";
export type { RunRequest } from "./prompt.js";
export {
  envSecrets,
  firstOf,
  keychainSecrets,
  type SecretStore,
} from "./secrets.js";

export interface Lifecycle {
  readonly handlers: LifecycleHandlers;
  /** Upserts the prompt templates (§8.2), loads the settings, runs one reconciler pass, then one
   * every reconciler.interval_ms after the last ends. Call before the claimer starts. */
  boot(): Promise<Result<void>>;
  /** Cancels the loop and run timers: no state change, no kill. */
  shutdown(): Promise<void>;
  /** One reconciler pass now. */
  reconcile(): Promise<void>;
  /** Settles once every queued session op has settled. */
  settled(): Promise<void>;
  /**
   * Starts a session the same way the `session.spawn` command handler does, resolving to its id.
   * For the supervisor's own internal triggers only (exporter self-trigger): never
   * reachable over HTTP, since Invariant 5 reserves inserting `commands` for the API.
   */
  spawn(payload: SessionSpawnPayload): Promise<Result<string>>;
  /**
   * Opens run `req.seq` on an idle session, on the session's queue (run.ts `startRun`): for the
   * supervisor's own triggers, e.g. a hand-off request or a pulse. A refusal opens no run.
   */
  startRun(sessionId: string, req: RunRequest): Promise<Result<RunRow>>;
  /**
   * The supervisor's own spawns: the pulse's orchestrator, M2-c's successor,
   * M3-h's review. Never reachable from a command.
   */
  spawnInternal(spec: InternalSpawn): Promise<Result<string>>;
  /** Stops a session as session.stop does (a spawn in progress is aborted), on its queue. */
  stop(sessionId: string, mode: StopMode): Promise<void>;
  /** Told after every session's last edge commits. Returns the unsubscribe. */
  onSessionEnded(fn: (e: SessionEnded) => void): () => void;
  /**
   * Told when a hand-off becomes pending: finalized full or degraded, never while it is being
   * written (§9.7: a completion wake; design §3 (b)). Returns the unsubscribe.
   */
  onHandoffPending(fn: (e: HandoffPending) => void): () => void;
  /** The watchdog: step 8 of each pass, and its own stuck timer. */
  readonly watchdog: Watchdog;
  /**
   * One worktree sweep pass now (§9.6 step 6), after any running one: its loop
   * never overlaps itself, and never waits on a session queue.
   */
  sweepWorktrees(): Promise<void>;
  /** A coalesced sweep request, fire and forget (Q8): one more pass, after the minimum gap. */
  requestSweep(): void;
  /** The circuit breaker an earlier change calls before it re-staffs a ticket. */
  readonly circuit: CircuitBreaker;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  // The rows replace the defaults at boot, before the claimer delivers any command.
  let settings: LifecycleSettings = DEFAULT_SETTINGS;
  // Every executor the rows name replaces the host's own at boot.
  let executors = deps.executors;
  // The drain runs an admitted session's pipeline, from step 2, on its queue.
  const admission = createAdmission(
    () => ctx,
    (admitted, first) => {
      schedule(ctx, admitted.sessionId, "spawn", () =>
        runPipeline(ctx, admitted, first),
      );
    },
    deps.admissionHooks,
  );
  const candidates = new ReleaseCandidates();
  // Functions over ctx, read at call time: the watchdog never holds a session-queue op.
  const watchdog = createWatchdog({
    db: deps.db,
    clock: deps.clock,
    log: deps.log,
    candidates,
    killGraceMs: () => ctx.settings["lifecycle.kill_grace_ms"],
    probeTimeoutMs: () => ctx.settings["executor.health_timeout_ms"],
    liveProcesses: () =>
      [...ctx.live].flatMap(([sessionId, e]) =>
        e.proc === undefined || e.dead
          ? []
          : [
              {
                sessionId,
                executor: e.proc.executor,
                ref: e.proc.handle.executorRef,
              },
            ],
      ),
    checkCeilings: () => {
      for (const [id, e] of ctx.live) {
        if (e.proc !== undefined && !e.dead) {
          onCommitted(ctx, id, { skipUnchanged: true });
        }
      }
    },
    // The sweep is built below; the watchdog only ever calls this from a tick, and its loop starts
    // later still (watchdog.start()), so the binding is always initialised by the time it runs.
    // Never awaited: a watchdog op must not wait on the sweep's queue (MEDIUM-1).
    requestSweep: () => sweep.requestPass(),
    diskPaths: deps.diskPaths ?? [
      join(deps.frmHome, "runtime"),
      dirname(dbPath(deps.frmHome)),
    ],
    ...(deps.freePct === undefined ? {} : { freePct: deps.freePct }),
  });
  if (deps.retentionNow !== undefined) {
    watchdog.useRetention(deps.retentionNow);
  }
  const ctx: Ctx = {
    ...deps,
    get settings() {
      return settings;
    },
    get executors() {
      return executors;
    },
    path: deps.path ?? process.env.PATH ?? "/usr/bin:/bin",
    remote: remotePolicy(deps.db, {
      ...(deps.resolveHost === undefined ? {} : { resolve: deps.resolveHost }),
      ...(deps.remoteProtocols === undefined
        ? {}
        : { protocols: deps.remoteProtocols }),
    }),
    mcpUrl: deps.mcpUrl ?? DEFAULT_MCP_URL,
    mcpReachable: deps.mcpReachable ?? httpReachable,
    live: new Map(),
    queue: new KeyedQueue(),
    mirrors: new KeyedQueue(),
    adopts: new Map(),
    ended: new Set(),
    pending: new Set(),
    afterExit: new Map(),
    homeTag: deps.homeTag ?? homeTag(deps.frmHome),
    orphanScan: new Map(),
    jobRunners: deps.jobRunners ?? new Set(),
    admission,
    owned: new Set(),
    candidates,
    watchdog,
    ptyChannels: new Map(),
  };
  // §9.6 step 6 on its own loop: reads the DB and ctx.live, and waits only on
  // the mirror mutexes, one at a time. Never a session queue.
  const sweepDeps: SweepDeps = {
    db: deps.db,
    log: deps.log,
    clock: deps.clock,
    frmHome: deps.frmHome,
    get settings() {
      return ctx.settings;
    },
    get path() {
      return ctx.path;
    },
    get mirrors() {
      return ctx.mirrors;
    },
    liveIds: () => new Set(ctx.live.keys()),
    secrets: ctx.secrets,
    ...(deps.sweep?.hooks === undefined ? {} : { hooks: deps.sweep.hooks }),
  };
  const sweep = createSweepLoop({
    clock: deps.clock,
    runPass: (signal) => sweepPass(sweepDeps, signal),
    onError: (e) => {
      deps.log.error({ err: String(e) }, "sweep pass failed");
    },
  });
  const loop = new AbortController();
  const nextPass = (): void => {
    ctx.clock.after(ctx.settings["reconciler.interval_ms"], loop.signal).then(
      async () => {
        await pass(ctx);
        nextPass();
      },
      () => undefined, // shut down
    );
  };
  let unsubscribe = (): void => undefined;
  return {
    // A repo check in flight is stopped with the lifecycle (review L3).
    handlers: commandHandlers(ctx, loop.signal),
    async boot() {
      const templates = await upsertPromptTemplates(
        ctx.db,
        await Promise.all(Object.values(TEMPLATES).map(templateRecord)),
      );
      if (!templates.ok) return templates;
      const loaded = await loadSettings(ctx.db);
      if (!loaded.ok) return loaded;
      settings = loaded.value;
      // Every executor its rows name, before the first pass: a restart probes and adopts on them.
      if (deps.loadExecutors !== undefined) {
        const placed = await deps.loadExecutors(ctx.db);
        if (!placed.ok) return placed;
        executors = placed.value;
      }
      // A home tag given (main.ts): can each local executor's orphan scan see a tagged process?
      if (deps.homeTag !== undefined) await checkOrphanScans(ctx);
      // Capacity from the rows before anything is admitted.
      const rows = await listExecutors(ctx.db);
      if (!rows.ok) return rows;
      resizeSlots(ctx, rows.value);
      // The drain's wakes: any slot released, by whoever (LOW-3), and any session's end.
      const offSlots = [...ctx.executors.values()].map((ex) =>
        ex.slots.onRelease(() => ctx.admission.wake()),
      );
      const wakeOnEnd = (): void => ctx.admission.wake();
      ctx.ended.add(wakeOnEnd);
      // A run's end, then — in the same queue op, so no run can start in between — a takeover
      // asked for "after this step": the turn ended on its own, nothing is interrupted.
      const offTerminal = ctx.ingest.onTerminal((t) => {
        schedule(ctx, t.sessionId, "terminal", async () => {
          await onRunEnded(ctx, t.sessionId, t.runId);
          await takeAttachIntent(ctx, t.sessionId);
        });
      });
      // The in-flight ceilings: the turn ceiling and the handoff run's turn cap.
      const offCommit = ctx.ingest.onCommit((c) => {
        for (const id of c.sessionIds) onCommitted(ctx, id);
      });
      // A session's end frees its container, on its queue: afterExit came first.
      const reap = (e: SessionEnded): void => {
        schedule(ctx, e.sessionId, "reap", () => reapSession(ctx, e.sessionId));
      };
      ctx.ended.add(reap);
      // The watchdog's events: a run's end and a session's end check the ticket's
      // circuit; a pending hand-off asks the split question. Each is queued, never awaited here.
      const offWatchTerminal = ctx.ingest.onTerminal((t) => {
        watchdog.runEnded(t.sessionId, t.outcome);
      });
      const watchEnded = (e: SessionEnded): void => watchdog.sessionEnded(e);
      const watchPending = (e: HandoffPending): void =>
        watchdog.handoffPending(e);
      ctx.ended.add(watchEnded);
      ctx.pending.add(watchPending);
      unsubscribe = () => {
        offTerminal();
        offCommit();
        offWatchTerminal();
        ctx.ended.delete(reap);
        ctx.ended.delete(wakeOnEnd);
        ctx.ended.delete(watchEnded);
        ctx.pending.delete(watchPending);
        for (const off of offSlots) off();
      };
      // The stuck rule's own timer: the pass cannot reach a stuck session.
      watchdog.start();
      // Before any claim: the boot pass never requeues commands (startClaiming does).
      await pass(ctx, "boot");
      nextPass();
      // After the boot pass has orphaned abandoned spawns and ended dead sessions.
      if (deps.sweep !== undefined) sweep.start();
      return ok(undefined);
    },
    async shutdown() {
      loop.abort();
      unsubscribe();
      ctx.admission.shutdown();
      for (const entry of ctx.live.values()) entry.timer?.cancel.abort();
      await watchdog.stop();
      await sweep.stop();
    },
    watchdog,
    sweepWorktrees: () => sweep.runNow(),
    requestSweep: () => sweep.requestPass(),
    circuit: watchdog.circuit,
    reconcile: () => pass(ctx),
    // Until quiet: a drain may start a pipeline, whose end may free a slot and wake a drain again.
    // Queued waiters never hold this (CRITICAL-1).
    async settled() {
      do {
        await ctx.admission.settled();
        await ctx.queue.settled();
      } while (ctx.admission.busy() || !ctx.queue.idle());
    },
    spawn: (payload) => spawnSession(ctx, payload),
    startRun: (sessionId, req) =>
      ctx.queue.run(sessionId, () => startRun(ctx, sessionId, req)),
    spawnInternal: (spec) => spawnInternal(ctx, spec),
    stop: (sessionId, mode) => requestStop(ctx, sessionId, mode),
    onSessionEnded(fn) {
      ctx.ended.add(fn);
      return () => {
        ctx.ended.delete(fn);
      };
    },
    onHandoffPending(fn) {
      ctx.pending.add(fn);
      return () => {
        ctx.pending.delete(fn);
      };
    },
  };
}

async function pass(ctx: Ctx, phase: PassPhase = "periodic"): Promise<void> {
  try {
    await reconcilePass(ctx, phase);
  } catch (e) {
    ctx.log.error({ err: String(e) }, "reconciler pass failed");
  }
}

/** The host side main.ts wires in: executors, runner adapters by id, the secret store. */
export interface LifecycleHost {
  readonly executors: ReadonlyMap<string, ExecutorSlots>;
  readonly adapters: LifecycleDeps["adapters"];
  readonly secrets: SecretStore;
  readonly path?: string;
  /** FRM_MCP_URL: the API's /mcp that session runners call. Default: the local API's. */
  readonly mcpUrl?: string;
  /** Every executor its rows name, loaded at boot. */
  readonly loadExecutors?: LifecycleDeps["loadExecutors"];
  /** FRM_HOME_TAG as main.ts computed it: sessions carry it, and the boot self-checks the scan. */
  readonly homeTag?: string;
  /** The daemon's own job runners: exempt from `uncertified` only. */
  readonly jobRunners?: ReadonlySet<string>;
  /** single-flight early retention, for the watchdog's low-disk rule. */
  readonly retentionNow?: LifecycleDeps["retentionNow"];
}

/** The factory startSupervisor boots: it builds the lifecycle and registers its handlers. */
export function lifecycleFactory(host: LifecycleHost): LifecycleFactory {
  return (deps) => {
    const lifecycle = createLifecycle({
      db: deps.db,
      clock: deps.clock,
      log: deps.log,
      frmHome: deps.home,
      ingest: deps.ingest,
      // The periodic pass's command step requeues through the claimer.
      commands: deps.claimer,
      // §9.6 step 6: the daemon always sweeps.
      sweep: {},
      // attach registers a session's pty on this so the API can stream it.
      relay: deps.relay,
      ...host,
    });
    deps.claimer.register(lifecycle.handlers.spawn);
    deps.claimer.register(lifecycle.handlers.interrupt);
    deps.claimer.register(lifecycle.handlers.stop);
    deps.claimer.register(lifecycle.handlers.handoff);
    deps.claimer.register(lifecycle.handlers.health);
    deps.claimer.register(lifecycle.handlers.attach);
    deps.claimer.register(lifecycle.handlers.detach);
    deps.claimer.register(lifecycle.handlers.repoCheck);
    return lifecycle;
  };
}
