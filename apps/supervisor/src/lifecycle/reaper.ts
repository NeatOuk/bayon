// The reaper. At a session's end
// its container goes, after the gate engine's afterExit has read a reviewer's output back (that runs
// before endSession). Each reconciler pass lists what every executor holds for sessions
// once (the snapshot) and reaps what is ours and ownerless: our labelled containers whose session
// has ended, and our tagged processes (FRM_SESSION_ID and FRM_HOME_TAG in their environment) whose
// session has no entry here. Before an adopt, the session's own stragglers are killed first
// (Invariant 12). Nothing that matches less is touched. A session's root stays while it holds work
// in progress (§9.2); its pin refs in the executor's mirror go after it (mirror-pins.ts).
import { getSession, listSessionWorktrees, type SessionRow } from "@bayon/db";
import { setWorktreeState } from "@bayon/db/supervisor";
import type { Executor, Owned } from "@bayon/executors";
import type { Ctx } from "./context.js";
import { dropSessionPins, ended } from "./mirror-pins.js";
import { awaitSessionOp, type PassPhase } from "./pass-wait.js";

/** How often a killed straggler is re-probed, within lifecycle.kill_grace_ms. */
const STRAGGLER_PROBE_MS = 100;

/** One pass's view of what each executor holds: its list, or null when the listing failed. */
export type Snapshot = ReadonlyMap<string, readonly Owned[] | null>;

/**
 * Whose it is: our home's tag. LEGACY_NO_HOME_LABEL: a container made before an earlier change has no
 * frm.home and counts when its session has a row here; delete this clause when M4 closes (M4-n).
 */
const ours = (ctx: Ctx, o: Owned): boolean =>
  o.homeTag === ctx.homeTag || (o.kind === "container" && o.homeTag === null);

// Refs already warned about, so a pass every minute does not repeat itself.
const warned = new WeakMap<Ctx, Set<string>>();
function warnOnce(ctx: Ctx, key: string, obj: object, msg: string): void {
  const seen = warned.get(ctx) ?? new Set<string>();
  warned.set(ctx, seen);
  if (seen.has(key)) return;
  seen.add(key);
  ctx.log.warn(obj, msg);
}

/** Step 0: one listOwned per loaded executor that has it. */
export async function takeSnapshot(ctx: Ctx): Promise<Snapshot> {
  const out = new Map<string, readonly Owned[] | null>();
  for (const { executor } of ctx.executors.values()) {
    if (executor.listOwned === undefined) continue;
    try {
      out.set(executor.id, await executor.listOwned());
    } catch (e) {
      // Safe to log: an executor's listing errors carry counts, never an environment.
      ctx.log.error(
        { executor: executor.id, error: e },
        "cannot list what the executor holds: its adopts wait for the next pass",
      );
      out.set(executor.id, null);
    }
  }
  return out;
}

/**
 * Whether the root goes with the container: only once the session has exited for good (a
 * resumable one keeps its home) and holds no work in progress, i.e. no worktree, or a gate
 * reviewer's detached checkout, which is never work.
 */
export async function rootFate(
  ctx: Ctx,
  s: SessionRow,
): Promise<"keep" | "remove"> {
  // A gate's reviewer is never adopted (H3): its detached checkout is never work.
  if (s.gate_id !== null) return "remove";
  if (s.state !== "exited") return "keep";
  const worktrees = await listSessionWorktrees(ctx.db, s.id);
  return worktrees.ok && worktrees.value.length === 0 ? "remove" : "keep";
}

/** A session's end: its executor releases what `prepare` made for it. Local executors have nothing. */
export async function reapSession(ctx: Ctx, sessionId: string): Promise<void> {
  const found = await getSession(ctx.db, sessionId);
  if (!found.ok || !ended(found.value) || ctx.live.has(sessionId)) return;
  const executor = ctx.executors.get(found.value.executor_id)?.executor;
  if (executor?.release !== undefined) {
    await release(ctx, executor, found.value);
  }
}

/**
 * Step 5, from the pass's snapshot, each on its session's queue: a resource whose
 * session has no row here belongs to someone else, one whose session is live here is its own, and
 * the rest are ours to reap: an ended session's container released, a process killed.
 */
export async function reapOrphans(
  ctx: Ctx,
  snapshot: Snapshot,
  phase: PassPhase = "periodic",
): Promise<void> {
  const ops: Promise<void>[] = [];
  for (const [executorId, owned] of snapshot) {
    const executor = ctx.executors.get(executorId)?.executor;
    if (executor === undefined || owned === null) continue;
    for (const o of owned) {
      // Its own, escaped descendants included: not queued at all, so a live session's busy queue
      // never holds the pass. reapOne checks again on the queue.
      if (ctx.live.has(o.sessionId)) continue;
      ops.push(
        awaitSessionOp(
          ctx,
          o.sessionId,
          ctx.queue.run(o.sessionId, () => reapOne(ctx, executor, o)),
          phase,
          "reap",
        ),
      );
    }
  }
  // Concurrently: one pass-wide bound, however many there are.
  await Promise.all(ops);
}

async function reapOne(ctx: Ctx, executor: Executor, o: Owned): Promise<void> {
  const where = { executor: executor.id, sessionId: o.sessionId, ref: o.ref };
  if (!ours(ctx, o)) {
    warnOnce(ctx, o.ref, where, "another home's resource: not ours to touch");
    return;
  }
  const found = await getSession(ctx.db, o.sessionId);
  if (!found.ok) {
    warnOnce(
      ctx,
      o.ref,
      where,
      "a resource with no session here: not ours to touch",
    );
    return;
  }
  const s = found.value;
  if (ctx.live.has(s.id)) return; // its own, escaped descendants included
  if (o.kind === "container") {
    if (
      s.executor_id === executor.id &&
      ended(s) &&
      executor.release !== undefined
    ) {
      await release(ctx, executor, s);
    }
    return;
  }
  // A process of a session that has ended, or has no entry here (one this pass abandoned, or one
  // waiting for its adopt): a straggler.
  ctx.log.warn(
    { ...where, state: s.state },
    "an orphan process of ours: killing it",
  );
  try {
    await executor.cleanup(o.ref, "hard");
  } catch (e) {
    ctx.log.error(
      { ...where, err: String(e) },
      "cannot kill the orphan: the next pass retries",
    );
  }
}

/**
 * Before an adopt (Invariant 12): the session's own processes in the snapshot are
 * killed and seen dead within lifecycle.kill_grace_ms. False leaves the adopt to the next pass: one
 * still alive, or a failed local snapshot (LOW-6), which cannot prove them gone.
 */
export async function clearStragglers(
  ctx: Ctx,
  s: SessionRow,
  snapshot: Snapshot,
): Promise<boolean> {
  const executor = ctx.executors.get(s.executor_id)?.executor;
  if (executor === undefined) return true;
  const owned = snapshot.get(executor.id);
  if (owned === undefined) return true; // an executor that lists nothing
  if (owned === null) return executor.kind !== "local";
  const mine = owned.filter(
    (o) => o.kind === "process" && o.sessionId === s.id && ours(ctx, o),
  );
  if (mine.length === 0) return true;
  ctx.log.warn(
    { sessionId: s.id, refs: mine.map((o) => o.ref) },
    "stragglers of a session to adopt: killing them first",
  );
  for (const o of mine) {
    try {
      await executor.cleanup(o.ref, "hard");
    } catch (e) {
      ctx.log.error(
        { sessionId: s.id, ref: o.ref, err: String(e) },
        "cannot kill a straggler",
      );
    }
  }
  const deadline = ctx.clock.now() + ctx.settings["lifecycle.kill_grace_ms"];
  for (;;) {
    if (!(await anyAlive(executor, mine))) return true;
    if (ctx.clock.now() >= deadline) break;
    await ctx.clock.after(STRAGGLER_PROBE_MS);
  }
  ctx.log.warn(
    { sessionId: s.id },
    "a straggler outlived SIGKILL: the adopt waits",
  );
  return false;
}

async function anyAlive(
  executor: Executor,
  owned: readonly Owned[],
): Promise<boolean> {
  for (const o of owned) {
    try {
      if ((await executor.probe(o.ref)) === "alive") return true;
    } catch {
      return true; // unknown is not dead
    }
  }
  return false;
}

async function release(
  ctx: Ctx,
  executor: Executor,
  s: SessionRow,
): Promise<void> {
  const root = await rootFate(ctx, s);
  try {
    await executor.release?.(s.id, { root });
  } catch (e) {
    ctx.log.error(
      { sessionId: s.id, executor: executor.id, err: String(e) },
      "cannot release the session's container: the next pass retries",
    );
    return;
  }
  if (root === "remove") await markRemoved(ctx, s.id);
  ctx.log.info(
    { sessionId: s.id, executor: executor.id, root },
    "released the session's container",
  );
  // Its pin refs in the executor's mirror, once finished; the rest is the sweep's.
  await dropSessionPins(ctx, executor, s);
}

/** Its worktree rows follow the root it removed. */
async function markRemoved(ctx: Ctx, sessionId: string): Promise<void> {
  const rows = await listSessionWorktrees(ctx.db, sessionId);
  if (!rows.ok) return;
  for (const w of rows.value.filter((row) => row.state !== "removed")) {
    const moved = await setWorktreeState(ctx.db, w.id, "removed");
    if (!moved.ok) {
      ctx.log.error(
        { sessionId, worktree: w.id, error: moved.error },
        "cannot mark the worktree removed",
      );
    }
  }
}
