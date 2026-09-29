// How a reconciler pass waits on one session's queue. The boot pass waits for
// everything: nothing is claimed before it ends. A periodic pass waits at most
// reconciler.interval_ms: an op that holds one session's queue must not stall the pass for every
// other session. The op still runs once its queue frees; every reconciler op re-reads its row first.
import { settlesWithin } from "./async-util.js";
import type { Ctx } from "./context.js";

/** The boot pass runs before any claim; only a periodic pass requeues commands. */
export type PassPhase = "boot" | "periodic";

export async function awaitSessionOp(
  ctx: Ctx,
  sessionId: string,
  op: Promise<unknown>,
  phase: PassPhase,
  what: string,
): Promise<void> {
  const logged = op.then(
    () => undefined,
    (e: unknown) => {
      ctx.log.error({ sessionId, err: String(e) }, `${what} failed`);
    },
  );
  if (phase === "boot") return logged;
  const bound = ctx.settings["reconciler.interval_ms"];
  if (await settlesWithin(logged, ctx.clock, bound)) return;
  ctx.log.warn(
    { sessionId, what, waitedMs: bound },
    "reconciler: the session's queue is still busy; the pass goes on without it",
  );
}
