// session.stop and session.interrupt, run on the session's queue (§2 edges 7–9, 12).
import { getSession, type SessionRow } from "@bayon/db";
import { withdrawAndEnd } from "./admission.js";
import { runAfterExit } from "./after-exit.js";
import {
  isIn,
  move,
  patchEntry,
  SPAWN_STATES,
  type Ctx,
  type LiveProcess,
} from "./context.js";
import { endSession } from "./end.js";
import type { StopMode } from "./payloads.js";

/** Out of handoff_writing the stop edge is the seal: its `writing` row is finalized degraded. */
const STOPPABLE = ["running", "idle", "handoff_writing"] as const;
import { cleanupWithin, closeFor, stopProcess } from "./process.js";
import { cancelTimer, closeOpenRun } from "./run.js";

/**
 * session.stop's path, for the command and the supervisor's own callers (Lifecycle.stop, a pulse
 * lease's expiry). The intent first, so a process that exits meanwhile reads as stopped; the abort
 * ends a pipeline still waiting for a slot, in git or before its spawn; then stopOp on the queue.
 */
export function requestStop(
  ctx: Ctx,
  id: string,
  mode: StopMode,
): Promise<void> {
  const entry = ctx.live.get(id);
  if (entry !== undefined && entry.intent === undefined) {
    patchEntry(ctx, id, { intent: mode });
  }
  entry?.abort.abort();
  return ctx.queue.run(id, () => stopOp(ctx, id, mode));
}

export async function stopOp(
  ctx: Ctx,
  id: string,
  mode: StopMode,
): Promise<void> {
  const found = await getSession(ctx.db, id);
  if (!found.ok) {
    ctx.log.warn({ sessionId: id, error: found.error }, "stop: no session");
    return;
  }
  const s = found.value;
  const entry = ctx.live.get(id);
  if (isIn(SPAWN_STATES, s.state)) {
    // A pipeline queued ahead of this op has already unwound on the abort: only an orphan is left.
    if (entry === undefined) {
      await endSession(ctx, id, "abort", {
        exit_reason: "killed",
        error_message: "stopped before its process started",
      });
      return;
    }
    // A queued spawn ends here only if the drain has not claimed it;
    // once claimed, the pipeline unwinds on the abort, or the refusal's end owns it.
    return withdrawAndEnd(ctx, id);
  }
  // A suspended session has no process and no stop edge — resumability is protected on purpose —
  // so a kill is the one thing that ends it for good. A graceful stop is refused at
  // the command door, which names the remedy, rather than silently doing nothing here.
  if (s.state === "resumable") {
    if (mode !== "kill") return;
    await endSession(ctx, id, "discard", { exit_reason: "killed" });
    return;
  }
  if (!isIn(STOPPABLE, s.state)) return; // stopping, or ended
  // Unowned, or dead under us: whatever of its group survives is killed before the end.
  if (entry?.proc === undefined)
    return stopWithoutProcess(ctx, s, entry === undefined || entry.dead);
  return stopLive(ctx, s, entry.proc, mode);
}

async function stopLive(
  ctx: Ctx,
  s: SessionRow,
  proc: LiveProcess,
  mode: StopMode,
): Promise<void> {
  patchEntry(ctx, s.id, { intent: mode });
  cancelTimer(ctx, s.id);
  const stopping = await move(ctx, s.id, "stop");
  if (!stopping.ok) {
    ctx.log.warn({ sessionId: s.id, error: stopping.error }, "stop: no edge");
    return;
  }
  await stopProcess(ctx, proc, mode);
  await proc.closed;
  // After the process is gone, before the session ends.
  await runAfterExit(ctx, s.id, proc);
  const resumable =
    mode === "graceful" &&
    proc.adapter.caps().resumable &&
    s.runner_session_id !== null;
  await endSession(ctx, s.id, resumable ? "suspend" : "exit", {
    exit_reason: mode === "graceful" ? "ok" : "killed",
  });
}

/** Its process died under us, or was never ours: close the run and end the session. */
async function stopWithoutProcess(
  ctx: Ctx,
  s: SessionRow,
  cleanup: boolean,
): Promise<void> {
  const executor = ctx.executors.get(s.executor_id)?.executor;
  if (cleanup && executor !== undefined && s.executor_ref !== null) {
    await cleanupWithin(ctx, executor, s.executor_ref, {
      sessionId: s.id,
      ref: s.executor_ref,
    });
  }
  await closeOpenRun(ctx, s.id, closeFor("kill"));
  await endSession(ctx, s.id, "die", { exit_reason: "killed" });
}

/** Asks the open run to stop; its `terminal{interrupted}` then takes edge 6. */
export async function interruptOp(ctx: Ctx, id: string): Promise<void> {
  const proc = ctx.live.get(id)?.proc;
  if (proc === undefined) return;
  const asked = await proc.adapter.interrupt(proc.handle);
  if (!asked.ok)
    ctx.log.warn({ sessionId: id, error: asked.error }, "interrupt");
}
