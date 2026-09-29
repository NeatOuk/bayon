// The hand-off write path (§7.1–7.3): interrupt the open run → beginHandoff
// with a `writing` row → run n (handoff_request) inside handoff_writing under its own caps → on
// its end: stop the process → the seal → finalize the packet.
import {
  TEMPLATES,
  renderFacts,
  type ErrorClass,
  type Result,
} from "@bayon/core";
import { getOpenRun, getSession, listRuns, type RunRow } from "@bayon/db";
import { insertHandoffFacts, sealHandoff } from "@bayon/db/supervisor";
import type { HandoffReason } from "@bayon/proto";
import { settlesWithin } from "./async-util.js";
import {
  isIn,
  patchEntry,
  releaseEntry,
  schedule,
  type Ctx,
  type LiveProcess,
} from "./context.js";
import { finalizeRow, holds } from "./degraded.js";
import { gatherFacts } from "./facts.js";
import { EDGES } from "./fsm.js";
import { writePacketFile } from "./packet-file.js";
import { renderRow } from "./packet-render.js";
import { stopProcess } from "./process.js";
import { cancelTimer, startRun } from "./run.js";

const HANDING = ["running", "idle"] as const;

/** What a hand-off carries beyond its reason. */
export interface HandoffAsk {
  /** The agent's own why (`handoff_request`), or the operator's. */
  readonly note?: string | undefined;
  /**
   * The phase the successor takes up (§7.1 `phase_change`). Absent, the packet header
   * reads `<phase> → <phase>`, which is right for a ceiling and says nothing for a phase change.
   */
  readonly phaseTo?: string | undefined;
}

/**
 * Starts a hand-off: call it on the session's queue. A no-op unless the session is running or
 * idle, live under this supervisor, holds its ticket and is not handing off already.
 */
export async function requestHandoff(
  ctx: Ctx,
  id: string,
  reason: HandoffReason,
  ask: HandoffAsk = {},
): Promise<void> {
  const { note, phaseTo } = ask;
  const found = await getSession(ctx.db, id);
  if (!found.ok) return;
  const s = found.value;
  const entry = ctx.live.get(id);
  const proc = entry?.proc;
  if (
    !isIn(HANDING, s.state) ||
    proc === undefined ||
    entry?.dead === true ||
    entry?.handoff !== undefined
  ) {
    ctx.log.info({ sessionId: id, state: s.state, reason }, "no hand-off now");
    return;
  }
  const held = await holds(ctx, s);
  if (!held.ok || !held.value) {
    ctx.log.warn(
      { sessionId: id, reason },
      "no hand-off: the session holds no ticket",
    );
    return;
  }
  const quiet = await interruptOpenRun(ctx, id, proc);
  const gathered = await gatherFacts(ctx, s);
  if (!gathered.ok || s.ticket_id === null) {
    ctx.log.error(
      { sessionId: id, error: gathered.ok ? undefined : gathered.error },
      "no hand-off: cannot gather its facts",
    );
    return;
  }
  const { facts, place } = gathered.value;
  let text = "";
  const begun = await insertHandoffFacts(ctx.db, {
    ticket_id: s.ticket_id,
    from_session_id: id,
    reason,
    phase_from: s.run_class,
    phase_to: phaseTo ?? s.run_class,
    facts_json: JSON.stringify(facts),
    quality: "writing",
    render: (n, handoffId) => {
      const r = renderRow(ctx, {
        id: handoffId,
        n,
        reason,
        phase: s.run_class,
        phaseTo,
        quality: "writing",
        facts,
        judgement: null,
        verified: false,
        why: "the hand-off is being written",
      });
      text = r.text;
      return r;
    },
    begin: { from: EDGES.beginHandoff.from, to: EDGES.beginHandoff.to },
  });
  if (!begun.ok || !begun.value.created) {
    ctx.log.warn(
      { sessionId: id, error: begun.ok ? undefined : begun.error },
      "no hand-off: beginHandoff did not commit",
    );
    return;
  }
  const handoffId = begun.value.row.id;
  patchEntry(ctx, id, { handoff: { handoffId, capHit: false } });
  ctx.log.info({ sessionId: id, handoffId, reason }, "handoff_writing");
  if (place !== undefined) {
    const written = await writePacketFile(
      ctx,
      place.executor,
      place.dir,
      begun.value.row.packet_path,
      text,
    );
    if (!written.ok)
      ctx.log.warn({ sessionId: id, error: written.error }, "packet file");
  }
  // The open run never answered its interrupt: the process is wedged, so it is killed.
  if (!quiet) return finishHandoff(ctx, id, "interrupted", "kill");
  const started = await startHandoffRun(ctx, id, {
    reason,
    note,
    facts: renderFacts(facts),
    ...(phaseTo === undefined || phaseTo === s.run_class
      ? {}
      : { boundary: { from: s.run_class, to: phaseTo } }),
  });
  if (!started.ok) await finishHandoff(ctx, id, started.error.class);
}

/** Interrupts the open run and waits for its terminal; false if it never came. */
async function interruptOpenRun(
  ctx: Ctx,
  id: string,
  proc: LiveProcess,
): Promise<boolean> {
  const open = await getOpenRun(ctx.db, id);
  if (!open.ok || open.value === null) {
    cancelTimer(ctx, id);
    return true;
  }
  const asked = await proc.adapter.interrupt(proc.handle);
  if (!asked.ok)
    ctx.log.warn({ sessionId: id, error: asked.error }, "interrupt");
  const seen = await settlesWithin(
    ctx.ingest.terminalOf(open.value.id),
    ctx.clock,
    ctx.settings["lifecycle.interrupt_grace_ms"],
  );
  cancelTimer(ctx, id);
  return seen;
}

/** What the handoff_request prompt is filled from. */
interface HandoffRunInput {
  readonly reason: HandoffReason;
  readonly note: string | undefined;
  readonly facts: string;
  /**
   * The `boundary` section's two run-class names, only for a hand-off that ends a phase
   *. Data, not prose: the sentence they fill is in `handoff_request`'s own text,
   * where a version and a hash pin it (Invariant 8).
   */
  readonly boundary?: { readonly from: string; readonly to: string };
}

/** Run n: the handoff_request template under the handoff.* caps, inside handoff_writing. */
async function startHandoffRun(
  ctx: Ctx,
  id: string,
  i: HandoffRunInput,
): Promise<Result<RunRow>> {
  const runs = await listRuns(ctx.db, id);
  if (!runs.ok) return runs;
  return startRun(ctx, id, {
    seq: (runs.value.at(-1)?.seq ?? 0) + 1,
    trigger: "handoff",
    // A hand-off packet is always allowed: a paused or spent fleet still keeps its work (§13.4).
    turn: "handoff",
    template: TEMPLATES.handoff_request,
    inputs: {
      reason: i.note === undefined ? i.reason : `${i.reason}: ${i.note}`,
      facts: i.facts,
      ...(i.boundary === undefined ? {} : { boundary: i.boundary }),
    },
    capTokens: ctx.settings["handoff.prompt_tokens_cap"],
    wallClockMs: ctx.settings["handoff.wall_clock_ms"],
    within: "handoff_writing",
    onEnded: (run) => {
      schedule(ctx, id, "hand-off end", () =>
        finishHandoff(ctx, id, failureOf(ctx, id, run)),
      );
    },
  });
}

/** Why a handoff run failed, if it did: its state, or a cap it hit. */
function failureOf(ctx: Ctx, id: string, run: RunRow): ErrorClass | undefined {
  if (ctx.live.get(id)?.handoff?.capHit === true) return "over_budget";
  switch (run.state) {
    case "ok":
      return undefined;
    case "timeout":
      return "timeout";
    case "budget_stop":
      return "over_budget";
    case "interrupted":
      return "interrupted";
    default:
      return "runner_error";
  }
}

const WHY: Readonly<Partial<Record<ErrorClass, string>>> = {
  over_budget: "the cap hit",
  timeout: "the wall clock ran out",
  interrupted: "the run was interrupted",
};

/**
 * The handoff run ended (or never started): stop the process, then the seal (handOff or
 * handoffFail, in the same transaction that reads the judgement), then finalize the packet. On
 * the session's queue; a session no longer in handoff_writing was ended by another op.
 */
export async function finishHandoff(
  ctx: Ctx,
  id: string,
  failure: ErrorClass | undefined,
  /** `kill` when the open run never answered its interrupt (design §3 op A step 2). */
  mode: "graceful" | "kill" = "graceful",
): Promise<void> {
  const found = await getSession(ctx.db, id);
  if (!found.ok || found.value.state !== "handoff_writing") return;
  const entry = ctx.live.get(id);
  const failed =
    failure ?? (entry?.handoff?.capHit === true ? "over_budget" : undefined);
  if (entry?.proc !== undefined) {
    patchEntry(ctx, id, { intent: mode });
    cancelTimer(ctx, id);
    await stopProcess(ctx, entry.proc, mode);
    await entry.proc.closed;
  }
  const now = ctx.clock.now();
  const sealed = await sealHandoff(ctx.db, {
    session_id: id,
    handOff: { ...EDGES.handOff, patch: { exit_reason: "ok", ended_at: now } },
    handoffFail: {
      ...EDGES.handoffFail,
      patch: {
        exit_reason: "abandoned",
        error_class: failed ?? null,
        error_message:
          failed === undefined
            ? "no handoff_write before the hand-off run ended"
            : `the hand-off run ended: ${WHY[failed] ?? failed}`,
        ended_at: now,
      },
    },
    failed: failed !== undefined,
  });
  if (!sealed.ok) {
    ctx.log.warn({ sessionId: id, error: sealed.error }, "hand-off: no seal");
    return;
  }
  releaseEntry(ctx, id);
  const { handedOff, judged, handoff } = sealed.value;
  ctx.log.info(
    { sessionId: id, handoffId: handoff.id, handedOff, judged, failed },
    handedOff ? "session handed off" : "hand-off failed: abandoned",
  );
  const why =
    failed !== undefined
      ? (WHY[failed] ?? "the run failed")
      : "the session wrote no hand-off";
  const final = await finalizeRow(
    ctx,
    sealed.value.session,
    handoff.id,
    handedOff ? "full" : "degraded",
    why,
  );
  if (!final.ok) {
    ctx.log.error(
      { sessionId: id, handoffId: handoff.id, error: final.error },
      "cannot finalize the hand-off; the reconciler sweeps it",
    );
  }
}
