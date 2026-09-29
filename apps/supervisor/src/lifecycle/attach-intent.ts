// "Take over after this step": session.attach with `when: "turn_end"`. The ask is
// recorded on a running session and the agent is left alone; the open run's terminal ends the turn
// as it would have, and the queue op that took that terminal (index.ts, after onRunEnded) takes the
// session over, between turns. Nothing half-done is thrown away.
//
// The record is `sessions.attach_intent_*` (032): the GUI reads it, and a restart honours it.
// `Entry.attachIntent` only caches it, so a run's end needs no read; the reconciler's sweep below
// re-arms the cache from the row when an adopt or a restart has replaced the entry. There is no TTL
// of its own: an ask lasts at most as long as the open run, which its wall clock bounds (§13.2),
// and the attach lease's TTL starts only when the attach happens.
import { getSession, listAttachIntents, type SessionRow } from "@bayon/db";
import { clearAttachIntent, setAttachIntent } from "@bayon/db/supervisor";
import { attachNow, takeoverParts } from "./attach.js";
import { patchEntry, schedule, type Ctx, type Entry } from "./context.js";

/** session.attach with `when: "turn_end"`, on the session's queue. */
export function requestAttachAtTurnEnd(
  ctx: Ctx,
  id: string,
  clientToken?: string,
): Promise<void> {
  return ctx.queue.run(id, () => deferAttach(ctx, id, clientToken));
}

/**
 * Arms the takeover on a running session, or — when no run is open — takes the session now, as
 * `when: "now"` would: an idle session loses nothing, and any other state is attachNow's logged
 * no-op. Arming never touches the process: no stop, no interrupt, no signal. A later ask replaces
 * an earlier one's owner.
 */
async function deferAttach(
  ctx: Ctx,
  id: string,
  clientToken?: string,
): Promise<void> {
  const found = await getSession(ctx.db, id);
  if (!found.ok) return;
  const s = found.value;
  if (s.state !== "running") {
    await attachNow(ctx, id, clientToken);
    return;
  }
  const entry = ctx.live.get(id);
  if (entry === undefined) {
    ctx.log.warn(
      { sessionId: id },
      "no attach: not live under this supervisor",
    );
    return;
  }
  const parts = takeoverParts(ctx, s);
  if ("refused" in parts) {
    ctx.log.warn({ sessionId: id }, `no attach: ${parts.refused}`);
    return;
  }
  const intent = {
    owner: clientToken ?? crypto.randomUUID(),
    requestedAt: ctx.clock.now(),
  };
  const set = await setAttachIntent(ctx.db, id, {
    owner: intent.owner,
    at: intent.requestedAt,
  });
  if (!set.ok) {
    ctx.log.error(
      { sessionId: id, error: set.error },
      "no attach: cannot record the takeover",
    );
    return;
  }
  if (!set.value) {
    ctx.log.info({ sessionId: id }, "no attach: the session stopped running");
    return;
  }
  // A dead entry is replaced by its adopt: the sweep arms the new one, or takes an idle one over.
  if (!entry.dead) patchEntry(ctx, id, { attachIntent: intent });
  ctx.log.info(
    { sessionId: id, owner: intent.owner },
    "takeover deferred to the open run's end",
  );
}

/**
 * The turn-end hook: called by the terminal's queue op right after onRunEnded, so after edge 6 and
 * after a deferred phase hand-off. That order is deliberate — a session whose phase ended hands off,
 * and a takeover of a session handing off is dropped rather than losing the hand-off's phase_to.
 * A session still `running` has another run open (never this run's end, which edge 6 just took):
 * the ask waits for that one. Otherwise it is taken once — off the entry before any await — and the
 * attach runs in this same op, so no run can start between this run's end and the takeover.
 */
export async function takeAttachIntent(ctx: Ctx, id: string): Promise<void> {
  if (ctx.live.get(id)?.attachIntent === undefined) return;
  const found = await getSession(ctx.db, id);
  if (found.ok && found.value.state === "running") return;
  const intent = ctx.live.get(id)?.attachIntent;
  if (intent === undefined) return;
  patchEntry(ctx, id, { attachIntent: undefined });
  ctx.log.info(
    { sessionId: id, waitedMs: ctx.clock.now() - intent.requestedAt },
    "the open run ended: taking over",
  );
  await attachNow(ctx, id, intent.owner);
}

/** The session's entry when it holds a live process of this supervisor's, else undefined. */
function liveEntry(ctx: Ctx, id: string): Entry | undefined {
  const entry = ctx.live.get(id);
  return entry !== undefined && !entry.dead && entry.proc !== undefined
    ? entry
    : undefined;
}

/**
 * Whether the sweep has anything to do for `s`. A running session whose entry already holds the ask
 * waits for its run's end, and one with no live process here waits for its adopt: neither is queued.
 */
function needsAction(ctx: Ctx, s: SessionRow): boolean {
  const entry = liveEntry(ctx, s.id);
  if (s.state === "running") {
    return entry !== undefined && entry.attachIntent === undefined;
  }
  if (s.state === "idle") return entry !== undefined;
  return true;
}

/**
 * Every reconciler pass, after the adopts and after boot's orphan-socket reap (an attach makes its
 * socket before the row that claims it): each pending ask the in-memory path cannot see is acted on,
 * on its session's queue. Never awaited here: a queue a stuck op holds never holds the pass.
 */
export async function sweepAttachIntents(ctx: Ctx): Promise<void> {
  const rows = await listAttachIntents(ctx.db);
  if (!rows.ok) {
    ctx.log.error({ error: rows.error }, "cannot list pending takeovers");
    return;
  }
  for (const s of rows.value) {
    if (!needsAction(ctx, s)) continue;
    schedule(ctx, s.id, "pending takeover", () =>
      reconcileAttachIntent(ctx, s.id),
    );
  }
}

/**
 * One pending ask, as its row says now:
 * - `running` with a live process whose entry lost the ask (an adopt replaced it): re-armed.
 * - `idle` with a live process: its run already ended — through a supervisor restart, or a death the
 *   reconciler adopted — so the takeover happens now, with the owner the GUI tab is waiting for.
 * - any other state can never be taken over (stopping, handing off, attached, ended): cleared.
 */
async function reconcileAttachIntent(ctx: Ctx, id: string): Promise<void> {
  const found = await getSession(ctx.db, id);
  if (!found.ok) return;
  const s = found.value;
  const owner = s.attach_intent_owner;
  const at = s.attach_intent_at;
  if (owner === null || at === null) return; // taken or cancelled meanwhile
  const entry = liveEntry(ctx, id);
  if (s.state === "running") {
    if (entry !== undefined && entry.attachIntent === undefined) {
      patchEntry(ctx, id, { attachIntent: { owner, requestedAt: at } });
      ctx.log.info({ sessionId: id }, "pending takeover re-armed");
    }
    return;
  }
  if (s.state === "idle") {
    if (entry === undefined) return;
    ctx.log.info(
      { sessionId: id },
      "pending takeover: its run already ended; taking over now",
    );
    await attachNow(ctx, id, owner);
    return;
  }
  patchEntry(ctx, id, { attachIntent: undefined });
  const cleared = await clearAttachIntent(ctx.db, id);
  if (!cleared.ok) {
    ctx.log.error(
      { sessionId: id, error: cleared.error },
      "cannot clear a pending takeover",
    );
    return;
  }
  ctx.log.info(
    { sessionId: id, state: s.state },
    "pending takeover dropped: the session can no longer be taken over",
  );
}
