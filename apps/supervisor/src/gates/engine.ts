// The gate engine (M3-h): claims gate.run, spawns each gate's reviewer, decides
// the gate from what the reviewer's process left, through decideGate (rule 2), and polls every
// gates.supersede_poll_ms for gates stopped, hung or never started. start() runs the same pass
// once as the restart sweep (§9).
import { QueuedReason, ok, type JsonValue, type Result } from "@bayon/core";
import { GATE_RUN, getGate, getSession } from "@bayon/db";
import { GateRunPayload } from "@bayon/proto";
import type { CommandHandler } from "../commands/claimer.js";
import { isHeld, readFleetHold } from "../fleet-hold.js";
import type { SessionEnded } from "../lifecycle/index.js";
import {
  background,
  createGateCtx,
  settled,
  untrack,
  type GateCtx,
  type GateEngineDeps,
} from "./context.js";
import { decide, launch } from "./run-gate.js";
import { loadEngineSettings } from "./settings.js";
import { restart, tick } from "./sweep.js";

export type { GateEngineDeps } from "./context.js";

export interface GateEngine {
  readonly handler: CommandHandler<GateRunPayload>;
  /** The restart sweep, then the poll. Call after lifecycle.boot(). */
  start(): Promise<void>;
  /** One poll pass now. */
  tick(): Promise<void>;
  /** Settles once every gate in flight is tracked or decided, and every cleanup is done. */
  settled(): Promise<void>;
  /** Stops the poll and the hooks; waits for work in flight. Kills nothing. */
  stop(): Promise<void>;
}

/** Only while 011's row cannot be read: the poll must go on. */
const FALLBACK_POLL_MS = 5_000;

async function claim(
  ctx: GateCtx,
  p: GateRunPayload,
): Promise<Result<JsonValue>> {
  const gate = await getGate(ctx.d.db, p.gate_id);
  if (!gate.ok) return gate;
  if (gate.value.state !== "running") {
    return ok({ gate_id: p.gate_id, skipped: gate.value.state });
  }
  if (ctx.inFlight.has(p.gate_id) || ctx.byGate.has(p.gate_id)) {
    return ok({ gate_id: p.gate_id, skipped: "in_flight" });
  }
  if ((await getSession(ctx.d.db, p.session_id)).ok) {
    // A replay after a crash: the reviewer ran across it (§2 step 2).
    background(
      ctx,
      `restart gate ${p.gate_id}`,
      restart(ctx, p.gate_id, [p.session_id]),
    );
    return ok({ gate_id: p.gate_id, session_id: p.session_id, replay: true });
  }
  // Held: no reviewer launches while the fleet is paused. The
  // gate stays running, and the poll launches it after the resume, its wall clock from then.
  const hold = await readFleetHold(ctx.d.db);
  if (isHeld(hold)) {
    ctx.d.log.info(
      { gateId: p.gate_id },
      "the fleet is held: the reviewer launches after the resume",
    );
    return ok({
      gate_id: p.gate_id,
      skipped: hold.ok ? "fleet_paused" : "fleet_hold_unreadable",
    });
  }
  launch(ctx, gate.value, p.session_id);
  return ok({ gate_id: p.gate_id, session_id: p.session_id });
}

/**
 * The admission gate that held a timed-out reviewer queued, from its ended row (which keeps it):
 * the gate's record then says the fleet held it, not a slow runner.
 */
async function heldBy(
  ctx: GateCtx,
  sessionId: string,
): Promise<{ readonly queued_reason?: QueuedReason }> {
  const s = await getSession(ctx.d.db, sessionId);
  if (!s.ok || s.value.queued_reason === null) return {};
  const queued = QueuedReason.safeParse(s.value.queued_reason);
  return queued.success ? { queued_reason: queued.data } : {};
}

/**
 * A reviewer's end: decide it if its afterExit never ran (no process). Its worktree is the sweep's
 *: it waits worktree.min_ended_ms and runs every check, g13 and the reviewer's
 * own commits included, which a cleanup at the moment of the end could not.
 */
function onEnded(ctx: GateCtx, e: SessionEnded): void {
  const t = untrack(ctx, e.sessionId);
  if (t === undefined) return;
  const collected = ctx.collected.delete(e.sessionId);
  ctx.stopping.delete(e.sessionId);
  background(
    ctx,
    `reviewer ${e.sessionId}'s end`,
    (async () => {
      if (!collected) {
        const reason =
          ctx.d.clock.now() >= t.deadline ? "timeout" : "reviewer_error";
        const held = reason === "timeout" ? await heldBy(ctx, e.sessionId) : {};
        await decide(ctx, t.gateId, e.sessionId, { reason, ...held }, []);
      }
    })(),
  );
}

export function createGateEngine(d: GateEngineDeps): GateEngine {
  const ctx = createGateCtx(d);
  const loop = new AbortController();
  let offEnded: (() => void) | undefined;
  let polling: Promise<void> | undefined;

  const poll = async (): Promise<void> => {
    while (!loop.signal.aborted) {
      const s = await loadEngineSettings(d.db);
      try {
        await d.clock.after(
          s.ok ? s.value.pollMs : FALLBACK_POLL_MS,
          loop.signal,
        );
      } catch {
        return; // stopped
      }
      await tick(ctx).catch((e: unknown) => {
        d.log.error({ err: String(e) }, "gate poll failed");
      });
    }
  };

  return {
    handler: {
      type: GATE_RUN,
      payload: GateRunPayload,
      // Built for replay: skipped unless running; a reviewer session → restart sweep.
      idempotent: true,
      handle: (p) => claim(ctx, p),
    },
    async start() {
      offEnded = d.lifecycle.onSessionEnded((e) => onEnded(ctx, e));
      await tick(ctx);
      polling = poll();
    },
    tick: () => tick(ctx),
    settled: () => settled(ctx),
    async stop() {
      ctx.state.stopped = true;
      loop.abort();
      offEnded?.();
      await polling;
      await settled(ctx);
    },
  };
}
