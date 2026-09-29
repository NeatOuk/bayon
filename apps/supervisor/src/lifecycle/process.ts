// A runner process under this supervisor: attached to ingest, watched for its exit, stopped.
import { ok, type Result } from "@bayon/core";
import { getOpenRun } from "@bayon/db";
import type { ExitInfo, SessionHandle } from "@bayon/runners";
import { runAfterExit } from "./after-exit.js";
import { settlesWithin } from "./async-util.js";
import {
  move,
  patchEntry,
  schedule,
  type Ctx,
  type Entry,
  type LiveProcess,
  type StopIntent,
} from "./context.js";
import { recordExit } from "./exit-record.js";
import type { SupervisorClose } from "./ports.js";

/** How ingest closes a run the stream left open, by why the process ended. */
export function closeFor(intent: StopIntent | undefined): SupervisorClose {
  if (intent === "timeout") {
    return {
      outcome: "timeout",
      errorClass: "timeout",
      message: "no terminal within the run's wall clock",
    };
  }
  if (intent === "budget") {
    return {
      outcome: "budget_stop",
      errorClass: "over_budget",
      message: "stopped at a hard cap",
    };
  }
  if (intent !== undefined) {
    return {
      outcome: "interrupted",
      errorClass: "interrupted",
      message: `stopped (${intent})`,
    };
  }
  return {
    outcome: "failed",
    errorClass: "runner_exited_without_terminal",
    message: "the runner exited with the run open",
  };
}

/**
 * The reconciler's close of a run whose process predates this supervisor:
 * the outcome stays (Invariant 3); only the class says the restart ended it. Never the live onEof.
 */
export const closeForRestart = (
  message: string,
  outcome: "failed" | "timeout" = "failed",
): SupervisorClose => ({ outcome, errorClass: "supervisor_restart", message });

/** Hands the process to ingest and watches for its end. */
export function attachProcess(
  ctx: Ctx,
  id: string,
  p: Omit<LiveProcess, "closed">,
  segmentOffset: number,
  /** Secret values this process's env holds: redacted before the raw log (Invariant 11). */
  redact: readonly string[] = [],
): Result<LiveProcess> {
  const attached = ctx.ingest.attach({
    sessionId: id,
    handle: p.handle,
    adapter: p.adapter,
    segmentOffset,
    onEof: () => closeFor(ctx.live.get(id)?.intent),
    redact,
  });
  if (!attached.ok) return attached;
  // When ingest read the process to EOF, on the lifecycle clock: a periodic pass reads it to find an
  // exit no op took (reconciler.ts noticeMissedExits).
  let eofAt: number | null = null;
  const closed = attached.value.closed.then(
    () => undefined,
    (e: unknown) => {
      ctx.log.error({ sessionId: id, err: String(e) }, "ingest failed");
    },
  );
  void closed.then(() => {
    eofAt = ctx.clock.now();
    schedule(ctx, id, "exit", () => onProcessGone(ctx, id, p.handle));
  });
  // Its exit code, signal and redacted stderr tail, beside the raw log, however it ends.
  void p.handle.exited.then(
    (exit) =>
      recordExit(ctx, id, {
        ref: p.handle.executorRef,
        segmentOffset,
        exit,
        redact,
      }),
    () => undefined,
  );
  const proc: LiveProcess = { ...p, closed, redact, eofAt: () => eofAt };
  patchEntry(ctx, id, { proc, dead: false });
  // This process watches it now: its later ends are not a restart's. And its EOF
  // is awaited too, not only its exit (§3.1).
  ctx.owned.add(id);
  ctx.candidates.track(id, p.executor, p.handle, closed);
  return ok(proc);
}

/**
 * What an entry becomes once its process is gone under this supervisor: its abort and its slot,
 * which it keeps until the reconciler adopts the session (reusing the slot) or ends it.
 */
export const deadEntry = (entry: Entry, missed?: LiveProcess): Entry => ({
  abort: entry.abort,
  dead: true,
  ...(entry.slot === undefined ? {} : { slot: entry.slot }),
  ...(missed === undefined ? {} : { missed }),
});

/**
 * A death under a live supervisor. Ingest has closed any open run at EOF (failed,
 * runner_exited_without_terminal); the entry is dead from here, so the reconciler adopts or ends the
 * session on its next pass. A stop or timer op owns its own exits. Nothing here waits unbounded on
 * the exit: an op that did held every later op of the session, its stop included.
 */
async function onProcessGone(
  ctx: Ctx,
  id: string,
  handle: SessionHandle,
): Promise<void> {
  const proc = goneProcess(ctx, id, handle);
  if (proc === undefined) return;
  const exit = await exitWithin(ctx, proc);
  ctx.log.warn(
    { sessionId: id, code: exit?.code, signal: exit?.signal },
    "the runner exited; the reconciler adopts or ends the session",
  );
  // Before the reconciler ends it.
  await runAfterExit(ctx, id, proc, exit ?? { stderrTail: "" });
  const open = await getOpenRun(ctx.db, id);
  if (open.ok && open.value === null) await move(ctx, id, "endRun");
}

/**
 * The process this exit op tears down, its entry dead from here; undefined when the op is not its
 * to take. A dead entry a periodic pass marked while this op waited in the queue (Entry.missed) is
 * finished whatever was asked since — a stop queued after it still ends the session. Otherwise its
 * own live entry, unless a stop or timer op owns the exit (an intent).
 */
function goneProcess(
  ctx: Ctx,
  id: string,
  handle: SessionHandle,
): LiveProcess | undefined {
  const entry = ctx.live.get(id);
  if (entry === undefined) return undefined;
  if (entry.dead) {
    const missed = entry.missed;
    if (missed?.handle !== handle) return undefined;
    ctx.live.set(id, { ...entry, missed: undefined });
    return missed;
  }
  if (entry.intent !== undefined || entry.proc?.handle !== handle) {
    return undefined;
  }
  entry.timer?.cancel.abort();
  ctx.live.set(id, deadEntry(entry));
  return entry.proc;
}

/**
 * Kills `ref`'s process group through `executor`, waiting at most lifecycle.kill_grace_ms for the
 * executor to answer: a hung executor call must not hold the session's queue either.
 */
export async function cleanupWithin(
  ctx: Ctx,
  executor: LiveProcess["executor"],
  ref: string,
  where: object,
): Promise<void> {
  const done = executor.cleanup(ref, "hard").catch((e: unknown) => {
    ctx.log.error({ ...where, err: String(e) }, "cleanup failed");
  });
  const grace = ctx.settings["lifecycle.kill_grace_ms"];
  if (await settlesWithin(done, ctx.clock, grace)) return;
  ctx.log.error(where, "cleanup did not answer within its grace");
}

/**
 * The process's exit once its stream has ended, waited for at most twice lifecycle.kill_grace_ms:
 * past the first grace its process group is killed (a CLI that closed its stdout and hangs), past
 * the second the caller goes on without it (undefined) — something may still hold its stderr, which
 * the watchdog's stuck rule releases. Never rejects.
 */
export async function exitWithin(
  ctx: Ctx,
  proc: LiveProcess,
): Promise<ExitInfo | undefined> {
  const { handle, executor } = proc;
  const exit = handle.exited.then(
    (info): ExitInfo | undefined => info,
    () => undefined,
  );
  const grace = ctx.settings["lifecycle.kill_grace_ms"];
  if (await settlesWithin(exit, ctx.clock, grace)) return exit;
  const where = { sessionId: handle.sessionId, ref: handle.executorRef };
  ctx.log.warn(
    where,
    "the runner's stream ended but its process has not exited: killing its process group",
  );
  await cleanupWithin(ctx, executor, handle.executorRef, where);
  if (await settlesWithin(exit, ctx.clock, grace)) return exit;
  ctx.log.error(
    where,
    "the runner's stream ended but its exit was not reported: going on without it",
  );
  return undefined;
}

/** Stops the process in `mode`; alive after lifecycle.kill_grace_ms → SIGKILL to its group. */
export async function stopProcess(
  ctx: Ctx,
  proc: LiveProcess,
  mode: "graceful" | "kill",
): Promise<void> {
  const { handle } = proc;
  const where = { sessionId: handle.sessionId, ref: handle.executorRef };
  const grace = ctx.settings["lifecycle.kill_grace_ms"];
  proc.adapter.stop(handle, mode).catch((e: unknown) => {
    ctx.log.error({ ...where, err: String(e) }, "adapter stop failed");
  });
  if (await settlesWithin(handle.exited, ctx.clock, grace)) return;
  ctx.log.warn(where, "still running after stop; killing its process group");
  await cleanupWithin(ctx, proc.executor, handle.executorRef, where);
  if (!(await settlesWithin(handle.exited, ctx.clock, grace))) {
    ctx.log.error(where, "the process did not exit after SIGKILL");
  }
}
