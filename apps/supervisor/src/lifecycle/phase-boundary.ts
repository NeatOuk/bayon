// The phase boundary, re-derived rather than remembered (§7.1 row four).
//
// The API ships a `session.handoff` in the transaction that ends a phase, and that command is the
// fast path — it is not the record. A boundary claimed while its session is mid-turn is armed on
// the in-memory `Entry` and the command row is already `done`, so a restart before the run ends
// drops it with `ctx.live`; a claim that finds no entry here (the boot pass has not adopted the
// session yet) drops it without a restart. Either way `transitionTicket` is the only emitter of a
// `phase_change` anywhere in the tree and the ticket cannot move again — staffing refuses
// `not_staffable` while a live session holds it — so the ticket is held for ever by a session
// nothing will release: the exact strand this ticket exists to end.
//
// So nothing new is stored and nothing is read back: every reconciler pass asks `phaseBoundary`
// again, over the rows, with the same pure function the API planned with — a boundary lost any way
// at all is found on the next pass. The repo doctrine says the reconciler, "at boot and every 60 s",
// is what makes supervisor restarts lossless; this is that promise kept for §7.1 row four.
//
// The one thing it will not do is *invent* a boundary. The command the transition inserted is the
// durable record that a release was asked for; a holder with no such row is not stranded, it is a
// session whose class simply never matched its ticket's status — an operator's own session, or a
// worker whose `ticket_update` was refused so nothing moved — and ending its work would be a bug
// of exactly the kind this sweep exists to prevent.
import { holdsTicket, phaseBoundary, type SessionState } from "@bayon/core";
import {
  askedPhaseHandoff,
  getSession,
  getTicket,
  listSessionsInStates,
  parseStatus,
  type SessionRow,
} from "@bayon/db";
import { patchEntry, schedule, type Ctx } from "./context.js";
import { requestHandoff } from "./handoff.js";

/** §7.1's reason for a hand-off that ends a phase. */
export const PHASE_CHANGE = "phase_change";

/**
 * Idle holders only. A session mid-turn is not stranded — its run ends, `endRun` puts it back to
 * idle and the next pass sees it — while the command path's deferral already owns that window; and
 * a `running` row whose process is gone belongs to the adopt path above, which lands it on `idle`
 * too. Sweeping `running` as well would race both for nothing.
 */
const SWEPT = ["idle"] as const satisfies readonly SessionState[];

/**
 * Re-derives the boundary for every idle session that still holds a ticket, and starts the hand-off
 * the lost command would have started. Idempotent by construction: a session already writing its
 * hand-off is refused by `requestHandoff`, and `beginHandoff` is a CAS out of idle, so at most one
 * hand-off is ever begun however often this runs.
 */
export async function sweepPhaseBoundaries(ctx: Ctx): Promise<void> {
  const sessions = await listSessionsInStates(ctx.db, [...SWEPT]);
  if (!sessions.ok) {
    ctx.log.error(
      { error: sessions.error },
      "cannot list sessions for the phase-boundary sweep",
    );
    return;
  }
  for (const s of sessions.value) {
    const boundary = await boundaryOf(ctx, s);
    if (boundary === undefined) continue;
    ctx.log.info(
      { sessionId: s.id, ticketId: s.ticket_id, phaseTo: boundary },
      "phase boundary re-derived: releasing the ticket its holder has finished with",
    );
    await startPhaseHandoff(ctx, s.id, s.state, boundary);
  }
}

/**
 * The phase `s` hands on to (null: the landed status asks for no run class — a waiting room), or
 * undefined when `s` is not at a boundary a transition asked to be released at. A ticket it does
 * not hold, a status the laws do not know, or no ask on record is never a boundary: this decides
 * nothing the API's own plan did not already decide.
 */
async function boundaryOf(
  ctx: Ctx,
  s: SessionRow,
): Promise<string | null | undefined> {
  if (s.ticket_id === null) return undefined;
  const found = await getTicket(ctx.db, s.ticket_id);
  if (!found.ok) {
    ctx.log.error(
      { sessionId: s.id, ticketId: s.ticket_id, error: found.error },
      "phase-boundary sweep: cannot read the ticket",
    );
    return undefined;
  }
  const ticket = found.value;
  if (!holdsTicket(s, ticket)) return undefined;
  const status = parseStatus(ticket.status);
  if (status === null) return undefined;
  // The boundary is re-derived from the status; only the *ask* is read back (see the file header).
  const boundary = phaseBoundary(s.run_class, status, ticket.complexity_tier);
  if (boundary === null) return undefined;
  const asked = await askedPhaseHandoff(ctx.db, s.id);
  if (!asked.ok) {
    ctx.log.error(
      { sessionId: s.id, error: asked.error },
      "phase-boundary sweep: cannot read the transition's command",
    );
    return undefined;
  }
  return asked.value ? boundary.to : undefined;
}

/**
 * Starts the phase-boundary hand-off for `id`, or arms it on the open run. A phase change is not
 * an emergency: a session still mid-turn usually has a commit or a note to finish, and
 * `requestHandoff` would interrupt it, so it waits for the run's end; a session already idle hands
 * off at once, as every other reason does. True when it was deferred.
 */
export async function startPhaseHandoff(
  ctx: Ctx,
  id: string,
  state: SessionState,
  phaseTo: string | null,
  note?: string | undefined,
): Promise<boolean> {
  const ask = {
    ...(note === undefined ? {} : { note }),
    ...(phaseTo === null ? {} : { phaseTo }),
  };
  const start = (): Promise<void> => requestHandoff(ctx, id, PHASE_CHANGE, ask);
  const deferred =
    state === "running" ? await deferHandoff(ctx, id, start) : false;
  if (!deferred) schedule(ctx, id, "hand-off", start);
  return deferred;
}

/**
 * Arms `start` on the session's live entry, for run.ts's `onRunEnded` to take once the open run
 * has ended. False: there is no live entry here (another supervisor's session, or one already
 * gone), or the run ended while this was being armed — the caller hands off now instead.
 * Identity, not a flag, decides who takes the closure: `onRunEnded` clears the field before
 * calling it, with no await in between, so exactly one side ever runs it.
 */
async function deferHandoff(
  ctx: Ctx,
  id: string,
  start: () => Promise<void>,
): Promise<boolean> {
  if (!ctx.live.has(id)) return false;
  patchEntry(ctx, id, { deferredHandoff: start });
  const again = await getSessionState(ctx, id);
  if (again === "running") {
    ctx.log.info({ sessionId: id }, "hand-off deferred to the open run's end");
    return true;
  }
  if (ctx.live.get(id)?.deferredHandoff !== start) return true;
  patchEntry(ctx, id, { deferredHandoff: undefined });
  return false;
}

async function getSessionState(
  ctx: Ctx,
  id: string,
): Promise<SessionState | null> {
  const found = await getSession(ctx.db, id);
  return found.ok ? found.value.state : null;
}
