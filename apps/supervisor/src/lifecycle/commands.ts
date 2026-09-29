// The lifecycle's command handlers (contract 6). Each settles fast; the work runs on the
// session's queue and reports through the session row.
import { err, ok, type Result, type SessionState } from "@bayon/core";
import { getSession } from "@bayon/db";
import { requestAttachAtTurnEnd } from "./attach-intent.js";
import { requestAttach, requestDetach } from "./attach.js";
import { schedule, type Ctx } from "./context.js";
import { holds } from "./degraded.js";
import { frmError } from "./errors.js";
import { requestHandoff } from "./handoff.js";
import { executorHealthHandler } from "./health-command.js";
import { PHASE_CHANGE, startPhaseHandoff } from "./phase-boundary.js";
import {
  SessionAttachPayload,
  SessionDetachPayload,
  SessionHandoffPayload,
  SessionInterruptPayload,
  SessionSpawnPayload,
  SessionStopPayload,
} from "./payloads.js";
import type { ExecutorHealthPayload } from "@bayon/proto";
import type { CommandHandler } from "./ports.js";
import { compileRun } from "./prompt.js";
import { STALE_SESSION, stillStale } from "./stale-holder.js";
import { admitBeforeRow } from "./admission.js";
import { createSessionRow, resolveSpawn } from "./resolve.js";
import { interruptOp, requestStop } from "./stop.js";
import { firstRun } from "./ticket-run.js";

/** A session.handoff re-delivered into one of these found the first delivery's hand-off. */
const HANDING_OFF: readonly string[] = ["handoff_writing", "handed_off"];

/**
 * The reasons that are the server noticing something about a ticket rather than someone
 * instructing a session: a phase it has finished, or a silence past
 * `watchdog.silent_ms`. Both are tolerant of a session that has already been released
 * by the time they are claimed; every other reason conflicts.
 */
const SERVER_REASONS: readonly string[] = [PHASE_CHANGE, STALE_SESSION];

/**
 * The states in which a late `phase_change` has nothing left to ask for, so the command is done
 * rather than failed: the session is already writing or has written its hand-off, is
 * already gone, or is on its way out with `beforeEnd`'s degraded row guaranteed (end.ts). Listed
 * explicitly rather than derived as "not running and not idle": `human_attached` and
 * `awaiting_approval` are neither releasing nor ended — the session is alive, still holds its
 * ticket, and detach runs it straight back to `idle` still holding. Swallowing those would strand
 * the ticket exactly as it was before this ticket, so they conflict like every other reason, and
 * the reconciler's re-derivation (phase-boundary.ts) picks the boundary up again afterwards.
 */
export const PHASE_RELEASED_STATES: readonly SessionState[] = [
  "handoff_writing",
  "handed_off",
  "stopping",
  "exited",
  "resumable",
];

export interface LifecycleHandlers {
  readonly spawn: CommandHandler<SessionSpawnPayload>;
  readonly interrupt: CommandHandler<SessionInterruptPayload>;
  readonly stop: CommandHandler<SessionStopPayload>;
  readonly handoff: CommandHandler<SessionHandoffPayload>;
  /** `executor.health`: the executor's own check, recorded. */
  readonly health: CommandHandler<ExecutorHealthPayload>;
  /** §12.5: takes or releases a session's attach (terminal takeover) lease. */
  readonly attach: CommandHandler<SessionAttachPayload>;
  readonly detach: CommandHandler<SessionDetachPayload>;
}

export function commandHandlers(ctx: Ctx): LifecycleHandlers {
  return {
    health: executorHealthHandler(ctx),
    spawn: {
      type: "session.spawn",
      payload: SessionSpawnPayload,
      // session_id is the key: a re-delivery finds its row and runs nothing twice.
      idempotent: true,
      handle: async (p) => {
        const r = await spawnSession(ctx, p);
        return r.ok ? ok({ session_id: r.value }) : r;
      },
    },
    interrupt: {
      type: "session.interrupt",
      payload: SessionInterruptPayload,
      // "The current turn" is relative to time: a late delivery would interrupt another one.
      idempotent: false,
      handle: async (p) => {
        const s = await getSession(ctx.db, p.session_id);
        if (!s.ok) return s;
        schedule(ctx, p.session_id, "interrupt", () =>
          interruptOp(ctx, p.session_id),
        );
        return ok({ session_id: p.session_id });
      },
    },
    stop: {
      type: "session.stop",
      payload: SessionStopPayload,
      // A target state: a stop of an ended session does nothing.
      idempotent: true,
      handle: async (p) => {
        const s = await getSession(ctx.db, p.session_id);
        if (!s.ok) return s;
        // The one stop that cannot reach its target state: a suspended session is
        // already stopped as gracefully as it can be, and only a kill discards it. Said here
        // rather than reported done, since the op itself runs off the queue and cannot answer.
        if (s.value.state === "resumable" && p.mode !== "kill") {
          return err(
            frmError(
              "conflict",
              `session ${p.session_id} is resumable: it is already stopped, and a graceful stop cannot end it. Stop it with mode "kill" to discard it for good.`,
            ),
          );
        }
        requestStop(ctx, p.session_id, p.mode).catch((e: unknown) => {
          ctx.log.error(
            { sessionId: p.session_id, err: String(e) },
            "stop failed",
          );
        });
        return ok({ session_id: p.session_id });
      },
    },
    handoff: {
      type: "session.handoff",
      payload: SessionHandoffPayload,
      // FSM-guarded: beginHandoff is a CAS and handed_off is final.
      idempotent: true,
      // §7.1: the operator's hand-off, or the agent's handoff_request (inserts both).
      handle: async (p, cmd) => {
        const s = await getSession(ctx.db, p.session_id);
        if (!s.ok) return s;
        // A re-delivery after a crash finds the hand-off the first delivery began: that is done.
        if (cmd.attempts > 1 && HANDING_OFF.includes(s.value.state)) {
          return ok({ session_id: p.session_id, replay: true });
        }
        if (s.value.state !== "running" && s.value.state !== "idle") {
          // A phase change is the server noticing a ticket moved, not an instruction to a session
          //: the session it names may already be handing off — one turn can cross two
          // boundaries, and each move ships its own command — or be gone entirely. Either way the
          // release it asks for has happened or can never happen, so the command is done, not
          // failed. Every other reason is someone asking this session to stop, and still conflicts.
          if (
            SERVER_REASONS.includes(p.reason) &&
            PHASE_RELEASED_STATES.includes(s.value.state)
          ) {
            return ok({ session_id: p.session_id, noop: s.value.state });
          }
          return err(
            frmError(
              "conflict",
              `session ${p.session_id} is ${s.value.state}: it cannot hand off now`,
            ),
          );
        }
        const held = await holds(ctx, s.value);
        if (!held.ok) return held;
        if (!held.value) {
          // Same reasoning: the ticket was closed, blocked or taken between the move that asked
          // for this release and the claim, so there is nothing left to hand off.
          if (SERVER_REASONS.includes(p.reason)) {
            return ok({ session_id: p.session_id, noop: "holds no ticket" });
          }
          return err(
            frmError(
              "validation",
              `session ${p.session_id} holds no ticket: nothing to hand off`,
            ),
          );
        }
        // The silence rule, asked again over the row as it is now: a session that has
        // spoken since the staffing call keeps its ticket, and the ask is simply spent. Before the
        // hand-off starts, so nothing is interrupted on the strength of a stale measurement.
        if (p.reason === STALE_SESSION && !(await stillStale(ctx, s.value))) {
          ctx.log.info(
            { sessionId: p.session_id, lastEventAt: s.value.last_event_at },
            "stale release: the session has spoken since; it keeps its ticket",
          );
          return ok({ session_id: p.session_id, noop: "no longer silent" });
        }
        // A phase change waits for the open run rather than interrupting it, and is the one reason
        // the reconciler can re-derive on its own (phase-boundary.ts): both live there, so the
        // command path and the restart path start the identical hand-off.
        if (p.reason === PHASE_CHANGE) {
          const deferred = await startPhaseHandoff(
            ctx,
            p.session_id,
            s.value.state,
            p.phase_to ?? null,
            p.note,
          );
          return ok({ session_id: p.session_id, deferred });
        }
        const ask = {
          ...(p.note === undefined ? {} : { note: p.note }),
          ...(p.phase_to === undefined ? {} : { phaseTo: p.phase_to }),
        };
        schedule(ctx, p.session_id, "hand-off", () =>
          requestHandoff(ctx, p.session_id, p.reason, ask),
        );
        return ok({ session_id: p.session_id, deferred: false });
      },
    },
    attach: {
      type: "session.attach",
      payload: SessionAttachPayload,
      // FSM-guarded: attach is a CAS from running/idle, so a re-delivery after it succeeded finds
      // the session already human_attached and simply does nothing more. A re-delivered turn_end
      // ask re-records the same owner.
      idempotent: true,
      handle: async (p) => {
        const s = await getSession(ctx.db, p.session_id);
        if (!s.ok) return s;
        // Absent `when` is `now`: a command stored before an earlier change still means what it meant.
        const when = p.when ?? "now";
        const attach =
          when === "turn_end"
            ? requestAttachAtTurnEnd(ctx, p.session_id, p.client_token)
            : requestAttach(ctx, p.session_id, p.client_token);
        attach.catch((e: unknown) => {
          ctx.log.error(
            { sessionId: p.session_id, err: String(e) },
            "attach failed",
          );
        });
        return ok({ session_id: p.session_id, when });
      },
    },
    detach: {
      type: "session.detach",
      payload: SessionDetachPayload,
      // Also the cancel of a pending "take over after this step", before it happened.
      idempotent: true,
      handle: async (p) => {
        const s = await getSession(ctx.db, p.session_id);
        if (!s.ok) return s;
        requestDetach(ctx, p.session_id).catch((e: unknown) => {
          ctx.log.error(
            { sessionId: p.session_id, err: String(e) },
            "detach failed",
          );
        });
        return ok({ session_id: p.session_id });
      },
    },
  };
}

/**
 * Resolves, runs admission's gates 1–5, creates the pending session (edge 1) and completes; the
 * admission drain then admits or queues it. Exported so the supervisor's own
 * internal triggers (exporter self-trigger) can start a session the same way the
 * `session.spawn` command does, without going through `commands` -- Invariant 5 governs who may
 * *insert a command*, not what the supervisor may call internally.
 */
export async function spawnSession(
  ctx: Ctx,
  p: SessionSpawnPayload,
): Promise<Result<string>> {
  // A re-delivered session.spawn (a requeued command) finds its row before anything is resolved:
  // nothing runs twice, and no gate re-decides a session that already runs (MEDIUM-3).
  const existing = await getSession(ctx.db, p.session_id);
  if (existing.ok) return ok(p.session_id);
  if (existing.error.class !== "not_found") return existing;
  const r = await resolveSpawn(ctx, p);
  if (!r.ok) return r;
  const { adapter, runClass } = r.value;
  // Run 1: the operator's prompt, else a ticket session's own (staffing sends no prompt).
  const first = await firstRun(ctx, r.value);
  if (!first.ok) return first;
  const run = first.value;
  // Pre-flight before anything is spawned (§8.4): an over-budget prompt fails the command.
  if (run !== undefined) {
    const checked = await compileRun(ctx, adapter, runClass, run);
    if (!checked.ok) return checked;
  }
  // Gates 1–5 before the row: a refusal fails the command with its gate, and writes no row.
  const admitted = await admitBeforeRow(ctx, r.value);
  if (!admitted.ok) return admitted;
  // The request is kept while pending: a restart re-admits the session from it.
  const created = await createSessionRow(ctx, admitted.value, p);
  if (!created.ok) return created;
  // Two concurrent deliveries make one row, so one waiter (LOW-B).
  if (created.value.created) {
    ctx.live.set(p.session_id, { abort: new AbortController(), dead: false });
    ctx.owned.add(p.session_id); // this process spawns it
    ctx.admission.enqueue({
      sessionId: p.session_id,
      admitted: admitted.value,
      first: run === undefined ? undefined : { run },
    });
  }
  return ok(p.session_id);
}
