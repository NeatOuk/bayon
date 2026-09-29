// The poll and the boot sweep: one pass over the running gates.
//   * A tracked gate that stopped running (superseded, waived) → its reviewer is killed.
//   * A tracked gate past its deadline + kill grace → decided timeout, then killed (§13.2).
//   * An untracked gate whose gate.run is still pending or claimed → left to the claimer. At boot
//     a claimed one is a crash's leftover, and the claimer's boot requeue re-delivers it or fails
//     it; at runtime it is being handled.
//   * An untracked gate with no reviewer session never started (M1): started, not decided, unless
//     past its deadline (then timeout).
//   * An untracked gate with a reviewer session ran across a restart → supervisor_restart, its
//     sessions killed; decideGate opens the retry.
//   * While the fleet is held, an untracked gate is neither
//     started nor timed out; after the resume its wall clock runs from the resume. A tracked
//     reviewer keeps the deadline it launched with: its turn in flight was never paused.
//   * A CI gate (core `isCiGate`) is none of these: it runs nothing, so it is never
//     "untracked, never started", and its deadline is its project's CI wait, not
//     gates.wall_clock_ms. The CI sweep (delivery/ci-checks.ts) decides it; this poll leaves it be.
import {
  isCiGate,
  newId,
  unlaunchedGateDeadline,
  type FleetHold,
  type GateSettings,
  type Result,
} from "@bayon/core";
import {
  getCommandByIdempotencyKey,
  getGate,
  gateRunKey,
  listGateSessions,
  listGatesInState,
  type CommandRow,
  type GateRow,
} from "@bayon/db";
import { GateRunPayload } from "@bayon/proto";
import { readFleetHold } from "../fleet-hold.js";
import { loadSettings } from "../lifecycle/settings.js";
import { kill, type GateCtx } from "./context.js";
import { decide, launch } from "./run-gate.js";
import { loadEngineSettings } from "./settings.js";

export async function tick(ctx: GateCtx): Promise<void> {
  const lifecycle = await loadSettings(ctx.d.db);
  if (lifecycle.ok) ctx.settings.current = lifecycle.value;
  const s = await loadEngineSettings(ctx.d.db);
  if (!s.ok) {
    ctx.d.log.error({ error: s.error }, "gate poll: settings");
    return;
  }
  await killStopped(ctx);
  const running = await listGatesInState(ctx.d.db, "running");
  if (!running.ok) {
    ctx.d.log.error(
      { error: running.error },
      "gate poll: cannot list running gates",
    );
    return;
  }
  const hold = await readFleetHold(ctx.d.db);
  if (!hold.ok) {
    ctx.d.log.error(
      { error: hold.error },
      "gate poll: cannot read fleet.paused; no gate starts or times out this pass",
    );
  }
  for (const gate of running.value) {
    if (ctx.inFlight.has(gate.id)) continue;
    if (isCiGate(gate)) continue;
    await visit(ctx, gate, s.value.gate, hold);
  }
}

async function visit(
  ctx: GateCtx,
  gate: GateRow,
  settings: GateSettings,
  hold: Result<FleetHold>,
): Promise<void> {
  const now = ctx.d.clock.now();
  const sessionId = ctx.byGate.get(gate.id);
  if (sessionId !== undefined) {
    const deadline =
      ctx.tracked.get(sessionId)?.deadline ??
      (gate.started_at ?? now) + settings.wall_clock_ms;
    const grace = ctx.settings.current["lifecycle.kill_grace_ms"];
    if (now > deadline + grace && !ctx.stopping.has(sessionId)) {
      ctx.d.log.warn(
        { gateId: gate.id, sessionId },
        "gate hung past its deadline: timeout",
      );
      await decide(ctx, gate.id, sessionId, { reason: "timeout" }, []);
      kill(ctx, sessionId);
    }
    return;
  }
  await untracked(ctx, gate, settings, hold);
}

/** Superseded or waived under a live reviewer: the API's session.stop usually came first. */
async function killStopped(ctx: GateCtx): Promise<void> {
  for (const t of [...ctx.tracked.values()]) {
    if (ctx.stopping.has(t.sessionId)) continue;
    const gate = await getGate(ctx.d.db, t.gateId);
    if (gate.ok && gate.value.state !== "running") {
      ctx.d.log.info(
        { gateId: t.gateId, state: gate.value.state },
        "the gate stopped running: killing its reviewer",
      );
      kill(ctx, t.sessionId);
    }
  }
}

/** The session id a gate.run named, if it parses. */
function payloadSession(cmd: CommandRow | null): string | null {
  if (cmd === null) return null;
  try {
    const parsed = GateRunPayload.safeParse(JSON.parse(cmd.payload_json));
    return parsed.success ? parsed.data.session_id : null;
  } catch {
    return null; // not JSON: the gate starts under a fresh id instead
  }
}

async function untracked(
  ctx: GateCtx,
  gate: GateRow,
  settings: GateSettings,
  hold: Result<FleetHold>,
): Promise<void> {
  const cmd = await getCommandByIdempotencyKey(ctx.d.db, gateRunKey(gate.id));
  if (!cmd.ok) {
    ctx.d.log.error(
      { gateId: gate.id, error: cmd.error },
      "gate poll: cannot read its gate.run",
    );
    return;
  }
  // The claimer's (LOW-3): a claimed gate.run at boot is re-delivered by the requeue.
  const state = cmd.value?.state;
  if (state === "pending" || state === "claimed") return;
  const sessions = await listGateSessions(ctx.d.db, [gate.id]);
  if (!sessions.ok) {
    ctx.d.log.error(
      { gateId: gate.id, error: sessions.error },
      "gate poll: cannot list its sessions",
    );
    return;
  }
  const ids = sessions.value.map((s) => s.session_id);
  if (ids.length > 0) return restart(ctx, gate.id, ids);
  if (!hold.ok || hold.value.paused) return; // held: neither started nor timed out
  const deadline = unlaunchedGateDeadline({
    startedAt: gate.started_at ?? ctx.d.clock.now(),
    wallClockMs: settings.wall_clock_ms,
    resumedAt: hold.value.resumedAt,
  });
  if (ctx.d.clock.now() >= deadline) {
    return decide(ctx, gate.id, null, { reason: "timeout" }, []);
  }
  ctx.d.log.info({ gateId: gate.id }, "a gate that never started: starting it");
  launch(ctx, gate, payloadSession(cmd.value) ?? newId(ctx.d.clock.now()));
}

/**
 * A reviewer that ran across a restart (§9): the gate is decided supervisor_restart with its newest
 * session (decideGate opens the retry), then every session of the gate is killed.
 */
export async function restart(
  ctx: GateCtx,
  gateId: string,
  sessionIds: readonly string[],
): Promise<void> {
  ctx.inFlight.add(gateId);
  try {
    ctx.d.log.warn({ gateId, sessionIds }, "a reviewer ran across a restart");
    await decide(
      ctx,
      gateId,
      sessionIds[0] ?? null,
      { reason: "supervisor_restart" },
      [],
    );
    for (const sid of sessionIds) kill(ctx, sid);
  } finally {
    ctx.inFlight.delete(gateId);
  }
}
