// The stuck rule, on the watchdog's own timer: a process whose child the
// executor saw exit more than lifecycle.kill_grace_ms ago, while its stream or its handle is still
// awaited, has its pipes released at the executor. Only executor methods run here, never a
// session-queue op (MEDIUM-1): the ops a stuck session's queue is held by are exactly the ones
// this unblocks. The facts are the supervisor's own: the executor's exit report and the
// candidate's two settled flags; never a probe, never CPU (Invariant 3).
import type { SessionHandle } from "@bayon/runners";
import type { Log } from "../lifecycle/context.js";
import { awaited, type ReleaseCandidates } from "./candidates.js";

/** A release draining this many graces in a row is forced (escape 3). */
export const DRAIN_CAP_GRACES = 10;

/** What the rule remembers between ticks, per handle. */
export interface StuckMemory {
  readonly released: WeakSet<SessionHandle>;
  readonly cleaned: WeakSet<SessionHandle>;
  readonly drainingSince: WeakMap<SessionHandle, number>;
}

export const newStuckMemory = (): StuckMemory => ({
  released: new WeakSet(),
  cleaned: new WeakSet(),
  drainingSince: new WeakMap(),
});

export interface StuckOptions {
  readonly candidates: ReleaseCandidates;
  readonly memory: StuckMemory;
  readonly now: number;
  readonly graceMs: number;
  readonly log: Log;
}

/** One pass over the candidates; resolves once each stuck one was cleaned and asked to release. */
export async function releaseStuck(o: StuckOptions): Promise<void> {
  for (const c of o.candidates.list()) {
    if (o.memory.released.has(c.handle) || !awaited(c)) continue;
    const exitedAt = c.executor.exitedAt?.(c.ref) ?? null;
    if (exitedAt === null || o.now - exitedAt <= o.graceMs) continue;
    const where = { sessionId: c.sessionId, ref: c.ref };
    // Kills whatever of its group still runs: when that was the pipe's holder, EOF follows.
    if (!o.memory.cleaned.has(c.handle)) {
      o.memory.cleaned.add(c.handle);
      try {
        await c.executor.cleanup(c.ref, "hard");
      } catch (e) {
        o.log.error({ ...where, err: String(e) }, "stuck: cleanup failed");
      }
    }
    const since = o.memory.drainingSince.get(c.handle);
    const force =
      since !== undefined && o.now - since >= DRAIN_CAP_GRACES * o.graceMs;
    const released = c.executor.releasePipes?.(c.ref, { force });
    if (released === undefined) continue;
    if (released.state === "draining") {
      if (since === undefined) o.memory.drainingSince.set(c.handle, o.now);
      continue;
    }
    if (released.state !== "released") continue;
    o.memory.released.add(c.handle);
    o.log.warn(
      { ...where, forced: force, pendingBytes: released.pendingBytes },
      force
        ? "stuck: released the pipes of an exited process nobody read; its buffered bytes were cut"
        : "stuck: released the pipes an exited process's descendant held open",
    );
  }
}
