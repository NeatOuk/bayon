// One pulse. decide() is steps 0–3: short database work, run on the agent's
// queue. runPulse() is steps 4–6: probes, the context pack and the spawn, off the queue, since the
// lease already makes the pulse single-flight. The terminal and the session's end do the rest.
import {
  PULSE_ROLE,
  PULSE_RUN_CLASS,
  TEMPLATES,
  newId,
  ok,
  type PulseSkipReason,
  type PulseTrigger,
  type Result,
} from "@bayon/core";
import {
  hasPulseWork,
  pulseHistory,
  pulseScopeOf,
  type AgentRow,
  type PulseCheckRow,
  type PulseRow,
  type RunRow,
} from "@bayon/db";
import {
  insertPulseChecks,
  leasePulse,
  updatePulse,
} from "@bayon/db/supervisor";
import { LOCAL_EXECUTOR_ID } from "../boot.js";
import { isHeld, readFleetHold } from "../fleet-hold.js";
import { isProjectHeld, readProjectFact } from "../project-hold.js";
import { failPulse } from "./lease.js";
import type { PulseRuntime } from "./runtime.js";

export type Decision =
  | { readonly kind: "running"; readonly pulse: PulseRow }
  | { readonly kind: "skipped"; readonly pulse: PulseRow }
  | {
      readonly kind: "capped";
      readonly pulse: PulseRow;
      readonly created: boolean;
    }
  | { readonly kind: "coalesced"; readonly pulse: PulseRow }
  | { readonly kind: "denied" };

/**
 * Steps 0–3: the gate, the lease (with the rate cap in its transaction), the free no-op check
 * (not for manual), then `running`. Every row it leases it also ends or starts, so an error after
 * the lease fails that pulse rather than strand it.
 */
export async function decide(
  rt: PulseRuntime,
  agent: AgentRow,
  trigger: PulseTrigger,
  scheduledAt: number,
): Promise<Result<Decision>> {
  const now = rt.clock.now();
  const gate = await rt.gate({ agentId: agent.id, trigger, now });
  const record = gate.allow ? undefined : gate.record;
  if (!gate.allow && record === undefined) return ok({ kind: "denied" });
  const lease = await leasePulse(rt.db, {
    agent_id: agent.id,
    trigger,
    scheduled_at: scheduledAt,
    lease_ttl_ms: rt.settings()["pulse.lease_ttl_ms"],
    max_per_hour: agent.pulse_max_per_hour,
  });
  if (!lease.ok) return lease;
  const l = lease.value;
  if (l.kind === "coalesced") return ok(l);
  if (l.kind === "capped") {
    if (l.firstInWindow) {
      rt.log.warn(
        {
          agentId: agent.id,
          pulseId: l.pulse.id,
          maxPerHour: agent.pulse_max_per_hour,
        },
        "pulse rate cap reached: interval-only until the trailing hour has room",
      );
    }
    return ok({ kind: "capped", pulse: l.pulse, created: l.created });
  }
  if (record !== undefined) return skip(rt, l.pulse, record);
  if (trigger !== "manual") {
    const work = await pendingWork(rt, agent, now);
    if (!work.ok) {
      await failPulse(rt, l.pulse, work.error.class);
      return work;
    }
    if (!work.value) return skip(rt, l.pulse, "nothing_to_do");
  }
  const running = await updatePulse(
    rt.db,
    { id: l.pulse.id, from: ["leased"] },
    { state: "running", started_at: now },
  );
  if (!running.ok) return running;
  rt.inFlight.add(running.value.id);
  return ok({ kind: "running", pulse: running.value });
}

/**
 * §9.7's free check: anything on v_needs_attention or completed since the last done pulse — for an
 * agent with a project, only that project's.
 */
async function pendingWork(
  rt: PulseRuntime,
  agent: AgentRow,
  now: number,
): Promise<Result<boolean>> {
  const history = await pulseHistory(rt.db, agent.id, now);
  if (!history.ok) return history;
  return hasPulseWork(
    rt.db,
    history.value.lastDoneAt ?? 0,
    pulseScopeOf(agent),
  );
}

/** A leased pulse skipped at $0: nothing is spawned, so no token is spent. */
async function skip(
  rt: PulseRuntime,
  pulse: PulseRow,
  reason: PulseSkipReason,
): Promise<Result<Decision>> {
  const skipped = await updatePulse(
    rt.db,
    { id: pulse.id, from: ["leased"] },
    {
      state: "skipped",
      skip_reason: reason,
      cost_usd: 0,
      ended_at: rt.clock.now(),
    },
  );
  if (!skipped.ok) return skipped;
  rt.log.info({ pulseId: pulse.id, reason }, "pulse skipped");
  return ok({ kind: "skipped", pulse: skipped.value });
}

/**
 * Steps 4–6 of a running pulse, bounded by its deadline (lease end − grace, review C1): probes
 * (aborted at the deadline), the context pack, then the orchestrator's spawn, whose slot wait and
 * run 1 end by the same deadline. A failure before the spawn fails the pulse.
 */
export async function runPulse(
  rt: PulseRuntime,
  agent: AgentRow,
  pulse: PulseRow,
): Promise<void> {
  const deadline =
    (pulse.lease_expires_at ?? rt.clock.now()) -
    rt.settings()["pulse.lease_grace_ms"];
  const cut = new AbortController();
  const timer = new AbortController();
  rt.clock.after(Math.max(0, deadline - rt.clock.now()), timer.signal).then(
    () => cut.abort(),
    () => undefined,
  );
  try {
    const failed = await steps(rt, agent, pulse, deadline, cut.signal);
    if (failed !== undefined) await failPulse(rt, pulse, failed);
  } finally {
    timer.abort();
    rt.inFlight.delete(pulse.id);
  }
}

/** Resolves to the pulse's fail reason, or undefined once its session is spawning. */
async function steps(
  rt: PulseRuntime,
  agent: AgentRow,
  pulse: PulseRow,
  deadline: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  const checks = await probeChecks(rt, pulse.id, signal);
  const inputs = await rt.pack.build({
    agentId: agent.id,
    pulseId: pulse.id,
    checks,
  });
  if (!inputs.ok) {
    rt.log.error({ pulseId: pulse.id, error: inputs.error }, "no context pack");
    return inputs.error.class;
  }
  if (rt.clock.now() >= deadline) return "timeout";
  // Paused since this pulse was decided: its spawn would only wait behind fleet_paused
  // until its deadline, so it ends now and frees its lease.
  const hold = await readFleetHold(rt.db);
  if (isHeld(hold)) return hold.ok ? "fleet_paused" : hold.error.class;
  // Its project paused since: the same, for this project's orchestrator only.
  const project = await readProjectFact(rt.db, agent.workspace_id);
  if (isProjectHeld(project)) {
    return project.ok ? "project_paused" : project.error.class;
  }
  const sessionId = newId(rt.clock.now());
  const spawned = await rt.lifecycle.spawnInternal({
    payload: {
      session_id: sessionId,
      agent_id: agent.id,
      role: PULSE_ROLE,
      run_class: PULSE_RUN_CLASS,
      ...(agent.executor_id === null ? { executor_id: LOCAL_EXECUTOR_ID } : {}),
    },
    run: {
      seq: 1,
      trigger: "pulse",
      template: TEMPLATES.pulse,
      inputs: inputs.value,
      onEnded: (run) => onRunEnded(rt, pulse.id, sessionId, run),
    },
    workspace: "none",
    requireTools: rt.requireTools,
    deadline,
    onCreated: (id) => link(rt, pulse.id, id),
  });
  if (!spawned.ok) {
    rt.log.warn(
      { pulseId: pulse.id, error: spawned.error },
      "the pulse's session was not spawned",
    );
    return spawned.error.class;
  }
  return undefined;
}

/** Step 4: the probes' results as pulse_checks rows. A probe failing is a row, never a failure. */
async function probeChecks(
  rt: PulseRuntime,
  pulseId: string,
  signal: AbortSignal,
): Promise<readonly PulseCheckRow[]> {
  const results = await rt.probes.run({ pulseId, signal });
  if (!results.ok) {
    rt.log.warn({ pulseId, error: results.error }, "the probes did not run");
    return [];
  }
  const rows = await insertPulseChecks(rt.db, pulseId, results.value);
  if (!rows.ok) {
    rt.log.error({ pulseId, error: rows.error }, "cannot record the probes");
    return [];
  }
  return rows.value;
}

/** InternalSpawn.onCreated: the pulse names its session before any event exists (§8). */
async function link(
  rt: PulseRuntime,
  pulseId: string,
  sessionId: string,
): Promise<Result<void>> {
  const linked = await updatePulse(
    rt.db,
    { id: pulseId, from: ["running"] },
    { session_id: sessionId },
  );
  if (!linked.ok) return linked;
  rt.sessions.set(sessionId, pulseId);
  return ok(undefined);
}

/** Run 1 ended (terminal or wall clock): one run per pulse, so the session stops; its end settles. */
function onRunEnded(
  rt: PulseRuntime,
  pulseId: string,
  sessionId: string,
  run: RunRow,
): void {
  rt.log.info(
    { pulseId, sessionId, runState: run.state },
    "the pulse's run ended: stopping its session",
  );
  rt.track(
    "stop the pulse's session",
    rt.lifecycle.stop(sessionId, "graceful"),
  );
}
