// The last edge of a session in this process, and the hand-off choke point (design,
// §7): every end of a holding session leaves a `handoffs` row, and an `ok` exit without one is
// abandoned (§3.2's exit law).
import { getHandoff, getSession, type HandoffRow } from "@bayon/db";
import type { HandoffReason } from "@bayon/proto";
import type { SessionPatch } from "@bayon/db/supervisor";
import {
  announceEnd,
  announceHandoffPending,
  move,
  releaseEntry,
  type Ctx,
} from "./context.js";
import { finalizeRow, holds, insertDegraded } from "./degraded.js";
import { EDGES, type EndEdge } from "./fsm.js";

/**
 * The ends that leave a holding session's hand-off: those of a session that had a process, the
 * reconciler's restartAbort, and `abort` — which never had a process, but whose
 * session may still hold a ticket (§13.1). A fresh staffing spawn holds by role alone
 * (core's holdsTicket), so a spawn that unwinds or an admission that refuses a re-admitted holder
 * would otherwise leave the ticket with no live owner, no pending hand-off and no terminal status.
 * `handOff` wrote its own row. `discard` is hooked for the same reason as `abort`: a
 * suspended session that never got a row — it held nothing when it suspended, or its insert failed
 * — must not take its ticket down with it when the operator gives up on resuming it.
 */
const HOOKED: ReadonlySet<EndEdge> = new Set([
  "exit",
  "suspend",
  "die",
  "reap",
  "handoffFail",
  "restartAbort",
  "abort",
  "discard",
]);

/**
 * The reconciler's ends: a failed read or degraded write leaves the session for its next pass
 * rather than end a holder without its row (MEDIUM-4). A stop has no one to retry it.
 */
const RETRIED: ReadonlySet<EndEdge> = new Set(["die", "restartAbort"]);

/**
 * The last edge of a session in this process. Once it commits, the entry goes: its timer is
 * cancelled and its slot released. A `conflict` means another op moved the session first, so
 * the entry and its slot stay with that op. Any other failure lets go of them too, and the
 * reconciler takes the unowned row on its next pass. A holding session gets its hand-off row
 * before the edge; a row it was still writing is finalized after it (the edge is the seal).
 */
export async function endSession(
  ctx: Ctx,
  id: string,
  edge: EndEdge,
  patch: SessionPatch,
): Promise<void> {
  const before = HOOKED.has(edge)
    ? await beforeEnd(ctx, id, edge, patch)
    : { proceed: true, patch, writing: null, degraded: null };
  if (!before.proceed) return;
  const ended = await move(ctx, id, edge, {
    ...before.patch,
    ended_at: ctx.clock.now(),
    // An ended session is never taken over: a pending "take over after this step" goes with it
    //, in the same statement, so the GUI never shows one on an ended row.
    attach_intent_owner: null,
    attach_intent_at: null,
  });
  const where = {
    sessionId: id,
    edge,
    state: EDGES[edge].to,
    exitReason: before.patch.exit_reason,
  };
  if (!ended.ok && ended.error.class === "conflict") {
    ctx.log.warn(
      { ...where, error: ended.error },
      "could not end the session: another op moved it first",
    );
    return;
  }
  releaseEntry(ctx, id);
  if (!ended.ok) {
    ctx.log.error(
      { ...where, error: ended.error },
      "could not end the session; the reconciler takes it",
    );
    return;
  }
  ctx.log.info(where, "session ended");
  if (before.writing !== null) {
    const final = await finalizeRow(
      ctx,
      ended.value,
      before.writing,
      "degraded",
      edge === "die" || edge === "reap"
        ? "the session died"
        : before.patch.error_class === "over_budget"
          ? "the cap hit"
          : "the session was stopped",
    );
    if (!final.ok) {
      ctx.log.error(
        { sessionId: id, handoffId: before.writing, error: final.error },
        "cannot finalize the hand-off; the reconciler sweeps it",
      );
    }
  }
  // The degraded row is takeable only now that the edge has ended its session (a successor needs
  // its predecessor ended): announced here, once. A sealed writing row was announced by finalizeRow.
  if (before.degraded !== null) {
    announceHandoffPending(ctx, before.degraded, ended.value);
  }
  // After the finalize: a completion wake for a hand-off finds its packet takeable.
  // An end that left a hand-off pending is marked so: that announcement was its one completion.
  announceEnd(
    ctx,
    ended.value,
    before.degraded !== null || before.writing !== null,
  );
}

/** A holding session's degraded row: its `handoffs.reason` and the packet's line. */
function degradedCause(
  edge: EndEdge,
  patch: SessionPatch,
  abandon: boolean,
): { readonly reason: HandoffReason; readonly why: string } {
  if (abandon) {
    return { reason: "operator", why: "the session exited without a hand-off" };
  }
  // Before the edge: a run past its wall clock across a restart ends by `die`.
  if (patch.exit_reason === "timeout") {
    return { reason: "session_death", why: "the run timed out" };
  }
  if (edge === "restartAbort") {
    return {
      reason: "session_death",
      why: "the supervisor restarted before its process started",
    };
  }
  // A spawn that unwound, or an admission that refused it after it was queued: no
  // process ever ran, so the packet carries only what git and the ticket already knew.
  if (edge === "abort") {
    return {
      reason: "session_death",
      why:
        patch.error_class === undefined || patch.error_class === null
          ? "its spawn did not finish"
          : `its spawn did not finish: ${patch.error_class}`,
    };
  }
  if (edge === "die" || edge === "reap") {
    return { reason: "session_death", why: "the session died" };
  }
  // it suspended cleanly and could have been resumed; the operator chose not to.
  if (edge === "discard") {
    return {
      reason: "operator",
      why: "the operator discarded it instead of resuming it",
    };
  }
  if (patch.error_class === "over_budget") {
    return { reason: "budget", why: "a hard cap hit" };
  }
  return { reason: "operator", why: "the session was stopped" };
}

interface BeforeEnd {
  /** False: the degraded row could not be written, so a death waits for the next pass. */
  readonly proceed: boolean;
  readonly patch: SessionPatch;
  /** The session's row still being written: finalized degraded once the edge has sealed it. */
  readonly writing: string | null;
  /** The degraded row this end wrote: announced as pending once the edge has committed. */
  readonly degraded: HandoffRow | null;
}

async function beforeEnd(
  ctx: Ctx,
  id: string,
  edge: EndEdge,
  patch: SessionPatch,
): Promise<BeforeEnd> {
  const unchanged: BeforeEnd = {
    proceed: true,
    patch,
    writing: null,
    degraded: null,
  };
  const wait: BeforeEnd = { ...unchanged, proceed: !RETRIED.has(edge) };
  const found = await getSession(ctx.db, id);
  if (!found.ok) {
    ctx.log.error(
      { sessionId: id, error: found.error },
      "cannot read the session",
    );
    return wait;
  }
  const s = found.value;
  if (s.handoff_out_id !== null) {
    const row = await getHandoff(ctx.db, s.handoff_out_id);
    const writing = row.ok && row.value.quality === "writing";
    return { ...unchanged, writing: writing ? s.handoff_out_id : null };
  }
  const held = await holds(ctx, s);
  if (!held.ok) {
    ctx.log.error(
      { sessionId: id, error: held.error },
      "cannot read the ticket",
    );
    return wait;
  }
  if (!held.value) return unchanged;
  const abandon =
    (edge === "exit" || edge === "suspend") && patch.exit_reason === "ok";
  const cause = degradedCause(edge, patch, abandon);
  const inserted = await insertDegraded(ctx, s, cause.reason, cause.why);
  if (!inserted.ok) {
    ctx.log.error(
      { sessionId: id, error: inserted.error },
      "cannot write the degraded hand-off",
    );
    // The reconciler's ends are retried by its next pass; a stop has no one to retry it.
    if (RETRIED.has(edge)) return wait;
  }
  const degraded = inserted.ok ? inserted.value : null;
  if (!abandon) return { ...unchanged, degraded };
  ctx.log.error(
    { sessionId: id, ticketId: s.ticket_id },
    "exit without a hand-off: abandoned (§3.2)",
  );
  return {
    ...unchanged,
    degraded,
    patch: { ...patch, exit_reason: "abandoned" },
  };
}
