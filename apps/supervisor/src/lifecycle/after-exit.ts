// InternalSpawn.afterExit: told once, after a session's process is
// observed closed and before the session's last edge, so its caller reads what the process left
// (a review's output file) while the executor still holds the session and before any reaper runs.
import { listRuns, type RunRow } from "@bayon/db";
import type { Executor } from "@bayon/executors";
import type { ExitInfo } from "@bayon/runners";
import { settlesWithin } from "./async-util.js";
import type { Ctx, LiveProcess } from "./context.js";

/** What the process left: its observed exit, its last run as stored, the executor it ran on. */
export interface AfterExitFacts {
  readonly exit: ExitInfo;
  readonly run: RunRow | null;
  readonly executor: Executor;
}

export type AfterExit = (facts: AfterExitFacts) => Promise<void>;

/** What a hook is told when the process's exit was never reported. */
const UNREPORTED: ExitInfo = { stderrTail: "" };

/**
 * Runs the session's hook once, if it has one. It is awaited up to lifecycle.interrupt_grace_ms: a
 * slow hook never holds the session's end past that (it goes on, unawaited), and one that throws
 * is logged. `exit`: the exit its caller already waited for; absent, it is waited for here, at most
 * lifecycle.kill_grace_ms — never unbounded on the session's queue.
 */
export async function runAfterExit(
  ctx: Ctx,
  id: string,
  proc: LiveProcess,
  exit?: ExitInfo,
): Promise<void> {
  const hook = ctx.afterExit.get(id);
  if (hook === undefined) return;
  ctx.afterExit.delete(id);
  const facts = {
    exit: exit ?? (await exitIfSettled(ctx, proc)),
    executor: proc.executor,
  };
  const runs = await listRuns(ctx.db, id);
  const run = runs.ok ? (runs.value.at(-1) ?? null) : null;
  const done = (async () => {
    try {
      await hook({ ...facts, run });
    } catch (e) {
      ctx.log.error({ sessionId: id, err: String(e) }, "afterExit failed");
    }
  })();
  const settled = await settlesWithin(
    done,
    ctx.clock,
    ctx.settings["lifecycle.interrupt_grace_ms"],
  );
  if (!settled) {
    ctx.log.warn(
      { sessionId: id },
      "afterExit is still running: the session ends without it",
    );
  }
}

async function exitIfSettled(ctx: Ctx, proc: LiveProcess): Promise<ExitInfo> {
  const exit = proc.handle.exited.then(
    (info) => info,
    () => UNREPORTED,
  );
  const settled = await settlesWithin(
    exit,
    ctx.clock,
    ctx.settings["lifecycle.kill_grace_ms"],
  );
  return settled ? exit : UNREPORTED;
}
