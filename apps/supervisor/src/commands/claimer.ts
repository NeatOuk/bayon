// The commands claimer (§9.5, contract 6): the API inserts commands, the supervisor claims them
// (a 1 s poll, or at once on a socket wake), runs the registered handler and records the result.
// It also requeues what a crash left `claimed`: at boot every claimed row, at
// runtime rows claimed too long ago, never a command it is running itself.
import type { Clock, ErrorClass, JsonValue, Result } from "@bayon/core";
import type { CommandRow, Db } from "@bayon/db";
import {
  claimCommand,
  completeCommand,
  requeueClaimedCommands,
  type CompleteCommand,
  type Requeued,
} from "@bayon/db/supervisor";
import type { Logger } from "pino";
import { z } from "zod";

export const COMMAND_POLL_MS = 1_000;

/** reconciler.command_max_attempts when no row sets it (the command requeue amendment). */
export const DEFAULT_COMMAND_MAX_ATTEMPTS = 3;

export interface CommandMeta {
  readonly id: string;
  /** 1 on the first claim. */
  readonly attempts: number;
  /** The Idempotency-Key the command was submitted with, if any. */
  readonly idempotencyKey?: string;
}

export interface CommandHandler<P> {
  readonly type: string;
  /** The payload schema; a payload it rejects fails the command with `validation`. */
  readonly payload: z.ZodType<P>;
  /** Must settle fast, unless `background`: long work belongs off the claim loop. */
  handle(p: P, cmd: CommandMeta): Promise<Result<JsonValue>>;
  /**
   * Runs off the claim loop (runner.conformance: minutes long). The loop claims on; the command
   * stays `claimed` until `handle` settles, then its result is recorded. stop() waits for it.
   */
  readonly background?: boolean;
  /**
   * Whether a delivery a crash cut short may run again: true only when a
   * second run changes nothing the first did. Required, so every handler decides.
   */
  readonly idempotent: boolean;
}

/** A requeue of claimed commands. */
export interface RequeueRequest {
  /** Claimed at or before this epoch ms; at boot, the ms before this process's first claim. */
  readonly claimedBefore: number;
  /** reconciler.command_max_attempts. */
  readonly maxAttempts: number;
  /** Why a command that is not idempotent is not retried: boot and runtime say different things. */
  readonly why: string;
}

/** What the reconciler uses of the claimer: requeueing what it is not running. */
export interface CommandRequeue {
  requeue(r: RequeueRequest): Promise<Result<Requeued>>;
}

export interface CommandClaimer extends CommandRequeue {
  /** A type registered twice throws: a wiring bug, found at boot. */
  register<P>(h: CommandHandler<P>): void;
  start(): void;
  /** Stops claiming; resolves once every command in flight, background ones too, is recorded. */
  stop(): Promise<void>;
  /** Claims now instead of at the next poll: the socket's `{"op":"wake"}`. */
  wake(): void;
  /** Every handler is registered: from now on a command of an unknown type fails. Wakes it. */
  wired(): void;
}

export interface ClaimerOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  readonly pollMs?: number;
  /**
   * Until `wired()`, a command whose type has no handler yet stays pending instead of failing:
   * the daemon registers most handlers after the claimer starts, and a command posted (or
   * requeued) meanwhile must wait for its handler. Default false: unknown fails at once.
   */
  readonly wiring?: boolean;
}

type Run = (cmd: CommandRow) => Promise<CompleteCommand>;
interface Registered {
  readonly run: Run;
  readonly background: boolean;
  readonly idempotent: boolean;
}

const failed = (cls: ErrorClass, message: string): CompleteCommand => ({
  state: "failed",
  error: { class: cls, message, retryable: false },
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // the payload schema then reports it
  }
}

const meta = (cmd: CommandRow): CommandMeta => ({
  id: cmd.id,
  attempts: cmd.attempts ?? 1,
  ...(cmd.idempotency_key === null
    ? {}
    : { idempotencyKey: cmd.idempotency_key }),
});

export function createClaimer(o: ClaimerOptions): CommandClaimer {
  const pollMs = o.pollMs ?? COMMAND_POLL_MS;
  const handlers = new Map<string, Registered>();
  let loop: Promise<void> | undefined;
  let stopped = false;
  let woken = false;
  let waiting: AbortController | undefined;
  let background: ReadonlySet<Promise<void>> = new Set();
  let wiring = o.wiring === true;
  // Claimed here and not yet recorded (LOW-2): a runtime requeue never touches them.
  let inflight: ReadonlySet<string> = new Set();
  const hold = (id: string): void => {
    inflight = new Set([...inflight, id]);
  };
  const drop = (id: string): void => {
    inflight = new Set([...inflight].filter((x) => x !== id));
  };

  function wakeUp(): void {
    woken = true;
    waiting?.abort();
  }

  async function outcome(cmd: CommandRow): Promise<CompleteCommand> {
    const h = handlers.get(cmd.type);
    if (h !== undefined) return h.run(cmd);
    o.log.error(
      { command: cmd.id, type: cmd.type },
      "unknown command type: failing the command",
    );
    return failed("unknown_command", `no handler for command type ${cmd.type}`);
  }

  async function record(cmd: CommandRow, result: CompleteCommand) {
    const done = await completeCommand(o.db, cmd.id, result);
    if (!done.ok) {
      o.log.error(
        { command: cmd.id, error: done.error },
        "recording a command's result failed",
      );
    }
  }

  /** Off the loop: recorded when it settles; stop() waits for it. */
  function detach(cmd: CommandRow): void {
    const job: Promise<void> = outcome(cmd)
      .then((result) => record(cmd, result))
      .finally(() => {
        background = new Set([...background].filter((j) => j !== job));
        drop(cmd.id);
      });
    background = new Set([...background, job]);
  }

  async function drain(): Promise<void> {
    woken = false;
    while (!stopped) {
      // While wiring, only types with a handler: the rest wait for theirs (or for wired()).
      const claimed = await claimCommand(
        o.db,
        wiring ? { types: [...handlers.keys()] } : {},
      );
      if (!claimed.ok) {
        o.log.error({ error: claimed.error }, "claiming a command failed");
        return;
      }
      const cmd = claimed.value;
      if (cmd === null) return;
      hold(cmd.id);
      if (handlers.get(cmd.type)?.background === true) {
        detach(cmd);
        continue;
      }
      try {
        await record(cmd, await outcome(cmd));
      } finally {
        drop(cmd.id);
      }
    }
  }

  async function run(): Promise<void> {
    while (!stopped) {
      await drain();
      if (stopped || woken) continue;
      const wait = new AbortController();
      waiting = wait;
      try {
        await o.clock.after(pollMs, wait.signal);
      } catch {
        // wake() or stop() cut the poll short
      }
      waiting = undefined;
    }
  }

  async function runHandler<P>(
    h: CommandHandler<P>,
    cmd: CommandRow,
  ): Promise<CompleteCommand> {
    const payload = h.payload.safeParse(parseJson(cmd.payload_json));
    if (!payload.success) {
      return failed(
        "validation",
        `${cmd.type} payload: ${z.prettifyError(payload.error)}`,
      );
    }
    try {
      const result = await h.handle(payload.data, meta(cmd));
      return result.ok
        ? { state: "done", result: result.value }
        : { state: "failed", error: result.error };
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      o.log.error(
        { command: cmd.id, type: cmd.type, error: message },
        "command handler threw",
      );
      return failed("internal", `${cmd.type} handler threw: ${message}`);
    }
  }

  return {
    register<P>(h: CommandHandler<P>) {
      if (handlers.has(h.type)) {
        throw new Error(`command type ${h.type} is registered twice`, {
          cause: { class: "conflict", message: h.type, retryable: false },
        });
      }
      handlers.set(h.type, {
        background: h.background === true,
        idempotent: h.idempotent,
        run: (cmd) => runHandler(h, cmd),
      });
      if (wiring) wakeUp(); // a command held for this type is claimed now
    },
    start() {
      loop ??= run();
    },
    wired() {
      wiring = false;
      wakeUp();
    },
    async stop() {
      stopped = true;
      waiting?.abort();
      await loop;
      while (background.size > 0) await Promise.all([...background]);
    },
    wake() {
      wakeUp();
    },
    async requeue(r) {
      const entries = [...handlers.entries()];
      const out = await requeueClaimedCommands(o.db, {
        claimedBefore: r.claimedBefore,
        idempotentTypes: entries
          .filter(([, h]) => h.idempotent)
          .map(([t]) => t),
        knownTypes: entries.map(([t]) => t),
        exclude: [...inflight],
        maxAttempts: r.maxAttempts,
        why: r.why,
      });
      if (!out.ok) return out;
      const { requeued, failed: abandoned } = out.value;
      if (requeued.length > 0 || abandoned.length > 0) {
        o.log.warn(
          { requeued, failed: abandoned, why: r.why },
          "claimed commands requeued or failed",
        );
      }
      if (requeued.length > 0) wakeUp();
      return out;
    },
  };
}
