// The supervisor process (§9): the supervisor lock and the control socket (one per FRM_HOME),
// migrations, ingest, the heartbeat, the lifecycle's boot, then the commands claimer. Shutdown
// runs it all in reverse and kills no child: pipe-bound runners end on stdin EOF when this
// process exits and are adopted on the next boot (amendment 2).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Clock, type FrmError, type Result } from "@bayon/core";
import { getSettings, openDb, pulseIdForSession, type Db } from "@bayon/db";
import { migrateUp } from "@bayon/db/supervisor";
import type { SessionSpawnPayload } from "@bayon/proto";
import { ensureSocketDir } from "@bayon/executors";
import { registrations } from "@bayon/runners";
import type { Logger } from "pino";
import { z } from "zod";
import { upsertBootRows, warnUnusableGrants } from "./boot.js";
import type {
  HandoffPending,
  InternalSpawn,
  SessionEnded,
  StopMode,
} from "./lifecycle/index.js";
import {
  createClaimer,
  DEFAULT_COMMAND_MAX_ATTEMPTS,
  type CommandClaimer,
} from "./commands/claimer.js";
import { startHeartbeat } from "./heartbeat.js";
import { createIngest, type Ingest } from "./ingest/ingest.js";
import { acquireLock } from "./lock.js";
import {
  dbPath,
  homeTag,
  lockPath,
  relaySocketPath,
  socketPath,
} from "./paths.js";
import { openRelayServer, type RelayServer } from "./relay.js";
import { checkSocketPath, openControlSocket } from "./socket.js";

/** The session lifecycle: boots before the claimer starts, stops after it. */
export interface Lifecycle {
  boot(): Promise<Result<void>>;
  /** Cancels timers; changes no state and kills nothing. */
  shutdown(): Promise<void>;
  /**
   * Starts a session the same way the `session.spawn` command handler does, resolving to its id.
   * For the supervisor's own internal triggers (exporter self-trigger): the supervisor
   * owns sessions, so this needs no `commands` row -- Invariant 5 governs who may *insert* a
   * command, not what the supervisor calls on itself.
   */
  spawn(payload: SessionSpawnPayload): Promise<Result<string>>;
  /** The supervisor's own spawns with their own run 1: the pulse's. */
  spawnInternal(spec: InternalSpawn): Promise<Result<string>>;
  /** Stops a session as session.stop does, on its queue. */
  stop(sessionId: string, mode: StopMode): Promise<void>;
  /** Told after every session's last edge commits. Returns the unsubscribe. */
  onSessionEnded(fn: (e: SessionEnded) => void): () => void;
  /** Told when a hand-off becomes pending (never while written). Returns the unsubscribe. */
  onHandoffPending(fn: (e: HandoffPending) => void): () => void;
}

export interface LifecycleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  /** Register session.spawn, session.interrupt and session.stop here. */
  readonly claimer: CommandClaimer;
  readonly ingest: Ingest;
  readonly home: string;
  /** The relay server (§12.5): register a channel here to stream bytes (e.g. a
   * session's pty) to whichever process opens it on the API side. */
  readonly relay: RelayServer;
}

export type LifecycleFactory = (deps: LifecycleDeps) => Lifecycle;

export interface SupervisorOptions {
  /** FRM_HOME. */
  readonly home: string;
  /** Default: $FRM_HOME/foreman.db. */
  readonly dbPath?: string;
  readonly clock: Clock;
  readonly log: Logger;
  readonly version: string;
  readonly lifecycle?: LifecycleFactory;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  /**
   * The caller registers handlers after this returns: commands of unregistered types wait until
   * it calls `claimer.wired()`, instead of failing (the daemon's main).
   */
  readonly wiring?: boolean;
  /** Ingest failed; the process should shut down and exit non-zero. */
  readonly onFatal?: (error: FrmError) => void;
}

export interface Supervisor {
  readonly db: Db;
  readonly claimer: CommandClaimer;
  readonly ingest: Ingest;
  readonly lifecycle: Lifecycle;
  readonly relay: RelayServer;
  /**
   * Call once every handler is registered (main.ts, after its last): requeues every command a
   * previous process left `claimed` (idempotent ones back to pending, the rest failed; design
   *, then `claimer.wired()`. Idempotent. The boot requeue must know every handler's
   * `idempotent` flag, so nothing else runs it.
   */
  startClaiming(): Promise<Result<void>>;
  /** Idempotent. */
  shutdown(): Promise<void>;
}

/** Why a boot requeue fails a command it will not retry. */
const RESTART_WHY = "the supervisor restarted while it ran";

const MaxAttempts = z.int().min(1);

/** reconciler.command_max_attempts: the row's value, else the default. */
async function commandMaxAttempts(db: Db): Promise<Result<number>> {
  const key = "reconciler.command_max_attempts";
  const rows = await getSettings(db, [key]);
  if (!rows.ok) return rows;
  const raw = rows.value.get(key);
  if (raw === undefined) return ok(DEFAULT_COMMAND_MAX_ATTEMPTS);
  const parsed = MaxAttempts.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `setting ${key} is not an integer >= 1`,
        retryable: false,
      });
}

const NO_LIFECYCLE: Lifecycle = {
  boot: async () => ok(undefined),
  shutdown: async () => undefined,
  spawn: async () =>
    err({
      class: "not_found",
      message: "no lifecycle configured: spawn is unavailable",
      retryable: false,
    }),
  spawnInternal: async () =>
    err({
      class: "not_found",
      message: "no lifecycle configured: spawn is unavailable",
      retryable: false,
    }),
  stop: async () => undefined,
  onSessionEnded: () => () => undefined,
  onHandoffPending: () => () => undefined,
};

export async function startSupervisor(
  o: SupervisorOptions,
): Promise<Result<Supervisor>> {
  const path = socketPath(o.home);
  const fits = checkSocketPath(path);
  if (!fits.ok) return fits;
  try {
    mkdirSync(o.home, { recursive: true, mode: 0o700 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err({
      class: "internal",
      message: `cannot create ${o.home}: ${message}`,
      retryable: false,
    });
  }
  // A home too long for its sockets keeps them in a short private dir: this user's
  // own, 0700, or the supervisor refuses rather than listen where someone else could.
  const sockets = ensureSocketDir(dirname(path), o.home);
  if (!sockets.ok) return sockets;
  // Never inside one of this home's own sessions (MEDIUM-2): its orphan scan must never
  // find the supervisor's own ancestry among its orphans.
  if (process.env["FRM_HOME_TAG"] === homeTag(o.home)) {
    return err({
      class: "validation",
      message: "refusing to start inside one of this home's sessions",
      retryable: false,
    });
  }

  // One supervisor per FRM_HOME (Invariant 12). The lock comes before the socket is touched, so
  // two supervisors starting at once over one stale socket file cannot both come up.
  const lock = await acquireLock({
    path: lockPath(o.home),
    clock: o.clock,
    log: o.log,
  });
  if (!lock.ok) return lock;
  const undo: (() => Promise<unknown>)[] = [async () => lock.value.release()];
  const unwind = async (failed: Result<never>): Promise<Result<never>> => {
    for (const step of undo.toReversed()) await step();
    return failed;
  };

  // The claimer the socket wakes comes later.
  const wakes: { claimer?: CommandClaimer } = {};
  const socket = await openControlSocket({
    path,
    log: o.log,
    onWake: () => wakes.claimer?.wake(),
  });
  if (!socket.ok) return unwind(socket);
  undo.push(() => socket.value.close());

  const relay = await openRelayServer({
    path: relaySocketPath(o.home),
    log: o.log,
  });
  if (!relay.ok) return unwind(relay);
  undo.push(() => relay.value.close());

  const db = await openDb({ path: o.dbPath ?? dbPath(o.home), clock: o.clock });
  if (!db.ok) return unwind(db);
  undo.push(() => db.value.close());
  const migrated = await migrateUp(db.value);
  if (!migrated.ok) return unwind(migrated);
  // Amendment 4: runner, model and executor rows exist before the lifecycle or a command.
  const registered = await upsertBootRows(db.value, {
    registrations: registrations(),
    onDecertified: (d) =>
      o.log.warn(
        { runner: d.runner_id, executor: d.executor_id, reason: d.reason },
        "a conformance certification lapsed",
      ),
  });
  if (!registered.ok) return unwind(registered);
  await warnUnusableGrants(db.value, o.log);

  const ingest = createIngest({
    db: db.value,
    clock: o.clock,
    log: o.log.child({ component: "ingest" }),
    onFatal: o.onFatal,
    // spend.pulse_id (§8.9): a plain read, so replay gets it too.
    pulseOf: ({ sessionId }) => pulseIdForSession(db.value, sessionId),
  });
  undo.push(() => ingest.shutdown());
  const claimer = createClaimer({
    db: db.value,
    clock: o.clock,
    log: o.log.child({ component: "claimer" }),
    pollMs: o.pollMs,
    wiring: o.wiring === true,
  });
  wakes.claimer = claimer;
  const beat = await startHeartbeat({
    db: db.value,
    clock: o.clock,
    log: o.log,
    pid: process.pid,
    version: o.version,
    startedAt: o.clock.now(),
    intervalMs: o.heartbeatMs,
  });
  if (!beat.ok) return unwind(beat);
  undo.push(() => beat.value.stop());

  const running = claimer;
  const lifecycle =
    o.lifecycle?.({
      db: db.value,
      clock: o.clock,
      log: o.log,
      claimer: running,
      ingest,
      home: o.home,
      relay: relay.value,
    }) ?? NO_LIFECYCLE;
  const booted = await lifecycle.boot();
  if (!booted.ok) return unwind(booted);
  // Every claim this process makes is stamped at or after bootAt; the lock is held, so every row
  // claimed before it was a dead process's.
  const bootAt = o.clock.now();
  running.start();

  // The boot requeue, then wired().
  let claiming: Promise<Result<void>> | undefined;
  const startClaiming = (): Promise<Result<void>> =>
    (claiming ??= (async (): Promise<Result<void>> => {
      const max = await commandMaxAttempts(db.value);
      if (!max.ok) return max;
      const requeued = await running.requeue({
        claimedBefore: bootAt - 1,
        maxAttempts: max.value,
        why: RESTART_WHY,
      });
      if (!requeued.ok) return requeued;
      running.wired();
      return ok(undefined);
    })());
  o.log.info(
    { home: o.home, pid: process.pid, version: o.version },
    "supervisor started",
  );

  let stopping: Promise<void> | undefined;
  // Reverse boot order, the lock last (Invariant 12): until this process has flushed ingest,
  // closed its database and removed its socket, a second supervisor on the same FRM_HOME must
  // still be refused. A wake arriving meanwhile reaches a stopped claimer.
  const shutdown = async () => {
    await running.stop();
    await lifecycle.shutdown();
    await beat.value.stop();
    await ingest.shutdown();
    const closed = await db.value.close();
    if (!closed.ok)
      o.log.error({ error: closed.error }, "closing the database failed");
    await socket.value.close();
    await relay.value.close();
    lock.value.release();
    o.log.info("supervisor stopped; its children were left running");
  };
  return ok({
    db: db.value,
    claimer: running,
    ingest,
    lifecycle,
    relay: relay.value,
    startClaiming,
    shutdown: () => (stopping ??= shutdown()),
  });
}
