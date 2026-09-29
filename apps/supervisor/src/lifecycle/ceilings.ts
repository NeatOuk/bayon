// In-flight ceilings (§7.1, §8.4, §13.2, checked on each ingest commit. M4's
// watchdog calls checkCeilings too; it never reimplements it. The math is core's (judgeCeilings,
// priceUsage, contextPct); this file measures and acts:
// - measure: fold the new turn_end usage, then set sessions.cost_usd and context_peak_tokens in
//   one statement per check (commit notices coalesce into one check), never per event; context % is
//   of the effective window, min(run class cap, model window);
// - a hard cap (max_turns, max_tool_calls, cost_cap_usd): the open run gets budget_stop and the
//   session stops; inside handoff_writing it just stops, and the hand-off degrades (§13.2);
// - a soft threshold (context %, turns, cost %): requestHandoff, once, from running or idle;
// - the handoff run's own turn cap (M2 amendment e).
import {
  EMPTY_TALLY,
  contextPct,
  effectiveWindow,
  judgeCeilings,
  ok,
  priceUsage,
  tallyTurnEnd,
  type CeilingVerdict,
  type EffectiveWindow,
  type Result,
  type RunClass,
  type UsageTally,
} from "@bayon/core";
import {
  countRunTurnStarts,
  getEventsSince,
  getOpenRun,
  getRunnerModel,
  getSession,
  toCanonical,
  type EventRow,
  type SessionRow,
} from "@bayon/db";
import { finishRun, setSessionInFlight } from "@bayon/db/supervisor";
import { isIn, move, patchEntry, schedule, type Ctx } from "./context.js";
import { holds } from "./degraded.js";
import { endSession } from "./end.js";
import { requestHandoff } from "./handoff.js";
import { stopProcess } from "./process.js";
import { findRunClass } from "./resolve.js";
import { cancelTimer, tearDown } from "./run.js";

const CHECKED = ["running", "idle", "handoff_writing"] as const;
const PAGE = 1_000;

type Hard = Extract<CeilingVerdict, { kind: "hard" }>;
type Soft = Extract<CeilingVerdict, { kind: "soft" }>;

/** How a check was asked for. */
export interface CheckOptions {
  /** The watchdog's backstop: no write when nothing new was folded in. */
  readonly skipUnchanged?: boolean;
}

/** A commit touched the session: one check is queued, however many commits come meanwhile. */
export function onCommitted(ctx: Ctx, id: string, o: CheckOptions = {}): void {
  const entry = ctx.live.get(id);
  if (
    entry === undefined ||
    entry.dead ||
    entry.proc === undefined ||
    entry.ceilingCheck === true
  ) {
    return;
  }
  patchEntry(ctx, id, { ceilingCheck: true });
  schedule(ctx, id, "ceilings", async () => {
    patchEntry(ctx, id, { ceilingCheck: false });
    await checkCeilings(ctx, id, o);
  });
}

/**
 * One check: measure, then act on core's verdict. Call it on the session's queue. A session with
 * no live process under this supervisor, or not running, idle or handing off, is left alone.
 */
export async function checkCeilings(
  ctx: Ctx,
  id: string,
  o: CheckOptions = {},
): Promise<void> {
  const found = await getSession(ctx.db, id);
  const entry = ctx.live.get(id);
  if (
    !found.ok ||
    !isIn(CHECKED, found.value.state) ||
    entry?.proc === undefined ||
    entry.dead
  ) {
    return;
  }
  const runClass = await findRunClass(ctx, found.value.run_class);
  if (!runClass.ok) {
    ctx.log.error({ sessionId: id, error: runClass.error }, "ceilings");
    return;
  }
  const measured = await measure(ctx, found.value, runClass.value, o);
  if (!measured.ok) {
    ctx.log.error({ sessionId: id, error: measured.error }, "ceilings");
    return;
  }
  const s = measured.value.session;
  const verdict = judgeCeilings({
    turns: s.turns,
    toolCalls: s.tool_calls,
    costUsd: s.cost_usd,
    contextPct: measured.value.contextPct,
    runClass: runClass.value,
    handoffAtCostPct: ctx.settings["ceilings.handoff_at_cost_pct"],
  });
  if (verdict.kind === "hard") return hardStop(ctx, s, verdict);
  if (s.state === "handoff_writing") return checkHandoffTurns(ctx, s);
  if (verdict.kind === "soft") return softHandoff(ctx, s, verdict);
}

interface Measured {
  readonly session: SessionRow;
  readonly contextPct: number | undefined;
}

/**
 * Folds the new turn_end usage, then writes the session's cost (settled spend + the latest run's
 * steps × the model's prices) and context peak. Context % is of the effective window, min(the run
 * class's context_tokens_cap, the model's window): a cap above the window is clamped to it, with one
 * warning per session. No usage, or neither a cap nor a window: no context %. An
 * unpriced token kind: that run adds nothing until its spend row settles it. Never guessed.
 */
async function measure(
  ctx: Ctx,
  s: SessionRow,
  runClass: RunClass,
  o: CheckOptions,
): Promise<Result<Measured>> {
  const before = ctx.live.get(s.id)?.tally;
  const tally = await foldTurnEnds(ctx, s.id);
  if (!tally.ok) return tally;
  patchEntry(ctx, s.id, { tally: tally.value });
  const model =
    s.model === null
      ? ok(null)
      : await getRunnerModel(ctx.db, s.runner_id, s.model);
  if (!model.ok) return model;
  const effective = effectiveWindow(
    runClass.context_tokens_cap,
    model.value?.context_tokens,
  );
  warnClamped(ctx, s, effective);
  // The watchdog's backstop found nothing new folded in: it writes nothing.
  if (o.skipUnchanged === true && before?.cursor === tally.value.cursor) {
    return ok({
      session: s,
      contextPct: contextPct(tally.value.last, effective.tokens),
    });
  }
  const run = tally.value.run;
  const runCost =
    run === undefined || model.value === null
      ? undefined
      : priceUsage(run.usage, model.value);
  const written = await setSessionInFlight(ctx.db, {
    session_id: s.id,
    run_id: run?.id ?? null,
    run_cost_usd: runCost ?? 0,
    context_peak_tokens: tally.value.peakTokens ?? null,
  });
  if (!written.ok) return written;
  return ok({
    session: written.value,
    contextPct: contextPct(tally.value.last, effective.tokens),
  });
}

/**
 * A run class whose context cap is above its model's window would let a session run into the
 * runner's own limit before the hand-off fires: the window stands in for the cap, and
 * the operator is told once per session which cap to lower.
 */
function warnClamped(
  ctx: Ctx,
  s: SessionRow,
  effective: EffectiveWindow,
): void {
  const { clamped } = effective;
  if (clamped === undefined || ctx.live.get(s.id)?.windowClampWarned === true)
    return;
  patchEntry(ctx, s.id, { windowClampWarned: true });
  ctx.log.warn(
    {
      sessionId: s.id,
      runClass: s.run_class,
      model: s.model,
      capTokens: clamped.capTokens,
      windowTokens: clamped.windowTokens,
    },
    "ceiling: the run class's context cap is above the model's window; measuring against the window",
  );
}

/** The session's turn_end events stored since the entry's cursor, folded into its tally. */
async function foldTurnEnds(ctx: Ctx, id: string): Promise<Result<UsageTally>> {
  let tally = ctx.live.get(id)?.tally ?? EMPTY_TALLY;
  for (;;) {
    const page = await getEventsSince(ctx.db, {
      sessionId: id,
      since: tally.cursor,
      kinds: ["turn_end"],
      limit: PAGE,
    });
    if (!page.ok) return page;
    tally = page.value.rows.map(turnEndOf).reduce(tallyTurnEnd, tally);
    if (!page.value.hasMore) return ok(tally);
  }
}

function turnEndOf(row: EventRow) {
  const e = toCanonical(row);
  const usage = e.kind === "turn_end" ? e.payload.usage : undefined;
  return {
    id: row.id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * A hard cap reached. Outside a hand-off the open run's verdict goes first, budget_stop (a CAS on
 * the run, as the run timer's timeout: a terminal that already won keeps its own), then the stop
 * edge, interrupt → its terminal → stop, and exited{error, over_budget}. The run's terminal event
 * is the runner's answer to the interrupt; ingest writes one only for a process that ends without
 * it (Invariant 3). Inside handoff_writing it just stops: the stop edge is the seal, and the
 * writing row is finalized degraded.
 */
async function hardStop(ctx: Ctx, s: SessionRow, v: Hard): Promise<void> {
  const proc = ctx.live.get(s.id)?.proc;
  if (proc === undefined) return;
  const message = `${v.cap} reached: ${v.value} of ${v.limit}`;
  const handing = s.state === "handoff_writing";
  const open = await getOpenRun(ctx.db, s.id);
  if (!open.ok) {
    ctx.log.error({ sessionId: s.id, error: open.error }, "hard cap: no run");
    return;
  }
  const run = open.value;
  if (run !== null && !handing) {
    const verdict = await finishRun(ctx.db, run.id, {
      state: "budget_stop",
      error_class: "over_budget",
      error_message: message,
    });
    if (!verdict.ok && verdict.error.class !== "conflict") {
      ctx.log.error({ sessionId: s.id, error: verdict.error }, "budget_stop");
    }
  }
  ctx.log.warn(
    { sessionId: s.id, state: s.state, cap: v.cap, value: v.value },
    "hard cap: stopping the session",
  );
  patchEntry(ctx, s.id, { intent: handing ? "graceful" : "budget" });
  cancelTimer(ctx, s.id);
  const stopping = await move(ctx, s.id, "stop");
  if (!stopping.ok) {
    ctx.log.warn(
      { sessionId: s.id, error: stopping.error },
      "hard cap: no stop",
    );
    return;
  }
  if (run === null) {
    await stopProcess(ctx, proc, "graceful");
    await proc.closed;
  } else {
    await tearDown(ctx, s.id, run, proc);
  }
  await endSession(ctx, s.id, "exit", {
    exit_reason: "error",
    error_class: "over_budget",
    error_message: message,
  });
}

/** A soft threshold: the hand-off is asked for once, and only by a session holding its ticket. */
async function softHandoff(ctx: Ctx, s: SessionRow, v: Soft): Promise<void> {
  const entry = ctx.live.get(s.id);
  if (entry?.handoff !== undefined || entry?.handoffAsked === true) return;
  const held = await holds(ctx, s);
  if (!held.ok || !held.value) return;
  patchEntry(ctx, s.id, { handoffAsked: true });
  ctx.log.info(
    { sessionId: s.id, reason: v.reason, value: v.value, limit: v.limit },
    "ceiling: hand off",
  );
  await requestHandoff(ctx, s.id, v.reason);
}

/** The handoff run may not begin turn `handoff.max_turns + 1`: a cap hit interrupts it. */
async function checkHandoffTurns(ctx: Ctx, s: SessionRow): Promise<void> {
  const entry = ctx.live.get(s.id);
  const proc = entry?.proc;
  if (
    entry?.handoff === undefined ||
    entry.handoff.capHit ||
    proc === undefined
  ) {
    return;
  }
  const open = await getOpenRun(ctx.db, s.id);
  if (!open.ok || open.value === null) return;
  const turns = await countRunTurnStarts(ctx.db, s.id, open.value.id);
  const max = ctx.settings["handoff.max_turns"];
  if (!turns.ok || turns.value <= max) return;
  patchEntry(ctx, s.id, { handoff: { ...entry.handoff, capHit: true } });
  ctx.log.warn(
    { sessionId: s.id, turns: turns.value, max },
    "hand-off run over its turn cap: interrupting it",
  );
  const asked = await proc.adapter.interrupt(proc.handle);
  if (!asked.ok)
    ctx.log.warn({ sessionId: s.id, error: asked.error }, "interrupt");
}
