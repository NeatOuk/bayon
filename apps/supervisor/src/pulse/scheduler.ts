// The pulse scheduler (§9.7): one armed wake per agent from core's next-wake
// math, completions heard in-process and polled, a tick, and one catchup at boot. Almost stateless:
// every decision re-reads the agent and its pulse history, and the hard limits are the database's.
import {
  PulsePolicy,
  admissionRefused,
  catchupAt,
  err,
  extendBurst,
  nextWake,
  ok,
  type Burst,
  type PulseTrigger,
  type Result,
} from "@bayon/core";
import {
  completionsSince,
  findLivePulse,
  getAgent,
  listPulseAgents,
  pulseHistory,
  type AgentRow,
  type CompletionCursor,
} from "@bayon/db";
import { isHeld, readFleetHold } from "../fleet-hold.js";
import { isProjectHeld, readProjectFact } from "../project-hold.js";
import type { SessionEnded } from "../lifecycle/index.js";
import { KeyedQueue } from "../lifecycle/session-queue.js";
import { settleSessionPulse, sweepPulses } from "./lease.js";
import type { PulseDeps } from "./ports.js";
import { decide, runPulse, type Decision } from "./pulse-run.js";
import type { PulseRuntime } from "./runtime.js";
import {
  DEFAULT_PULSE_SETTINGS,
  loadPulseSettings,
  type PulseSettings,
} from "./settings.js";

/** A timer never re-arms sooner than this: a guard against a hot loop (review H2), not a tunable. */
export const REARM_MIN_MS = 1_000;

export interface PulseWake {
  readonly at: number;
  readonly trigger: PulseTrigger;
}

export interface RunNowResult {
  readonly pulse_id: string | null;
  readonly outcome: Decision["kind"];
}

export interface PulseScheduler {
  /** The boot sweep, one catchup wake per agent, then the tick. */
  start(): Promise<void>;
  /** Cancels every wake and the tick, then waits for the work in flight. Kills nothing. */
  stop(): Promise<void>;
  /**
   * fanOutCompletion: a completion at `at` extends the burst of every
   * on_idle/hybrid agent that may act on it: the fleet's orchestrators (no project)
   * always, and a project's only for a completion of that project. `workspaceId` is the
   * completion's ticket's project, or null for none.
   */
  fanOutCompletion(at: number, workspaceId: string | null): void;
  /** Lifecycle.onSessionEnded: a ticket session's end is a completion; a pulse's session settles. */
  sessionEnded(e: SessionEnded): void;
  /** `pulse.run` (§9.7 manual): bypasses the no-op check and the gap, never the lease or cap. */
  runNow(agentId: string): Promise<Result<RunNowResult>>;
  /** One tick now: poll completions, re-list agents, sweep, re-plan. */
  tick(): Promise<void>;
  /** Settles once every queued decision and tracked piece of work has settled. */
  settled(): Promise<void>;
  /** The armed wake per agent: what the Fleet shows as the next pulse. */
  wakes(): ReadonlyMap<string, PulseWake>;
}

interface Armed extends PulseWake {
  readonly cancel: AbortController;
}

const policyOf = (a: AgentRow) =>
  PulsePolicy.safeParse({
    mode: a.pulse_mode,
    intervalMs: a.pulse_interval_ms,
    debounceMs: a.pulse_debounce_ms,
    minGapMs: a.pulse_min_gap_ms,
    maxPerHour: a.pulse_max_per_hour,
    jitterPct: a.pulse_jitter_pct,
    createdAt: a.created_at,
  });

const pulses = (a: AgentRow): boolean =>
  a.kind === "orchestrator" && a.enabled === 1;

export function createPulseScheduler(deps: PulseDeps): PulseScheduler {
  let settings: PulseSettings = DEFAULT_PULSE_SETTINGS;
  let agents: ReadonlyMap<string, AgentRow> = new Map();
  let cursor: CompletionCursor = { at: 0, ref: "" };
  let stopped = false;
  let ticking = false;
  const timers = new Map<string, Armed>();
  const bursts = new Map<string, Burst>();
  /** Agents whose last outcome wrote no row: left unarmed until the next tick (review H2). */
  const parked = new Set<string>();
  /** Agents whose boot catchup is armed: a re-plan leaves it standing until it fires. */
  const catchups = new Set<string>();
  const queue = new KeyedQueue();
  const work = new Set<Promise<void>>();
  const tickAbort = new AbortController();
  /** The fleet is paused (M4 §13.3): no wake is armed or fired until it resumes. */
  let frozen = false;
  /** Orchestrators whose project is paused, so each hold is logged once. */
  const projectHolds = new Set<string>();

  const track = (what: string, p: Promise<unknown>): void => {
    const tracked = p.then(
      () => undefined,
      (e: unknown) => {
        deps.log.error({ err: String(e) }, `${what} failed`);
      },
    );
    work.add(tracked);
    void tracked.finally(() => work.delete(tracked));
  };

  const rt: PulseRuntime = {
    ...deps,
    settings: () => settings,
    inFlight: new Set(),
    sessions: new Map(),
    track,
    replan: (agentId) => {
      parked.delete(agentId);
      plan(agentId);
    },
  };

  function plan(id: string): void {
    track(
      "pulse plan",
      queue.run(id, () => planNow(id)),
    );
  }

  function cancel(id: string): void {
    timers.get(id)?.cancel.abort();
    timers.delete(id);
    catchups.delete(id);
  }

  /**
   * Whether the fleet is held: paused, or its flag unreadable. Held, the scheduler is
   * frozen: every wake is cancelled and none is armed; the tick after the resume plans again.
   */
  async function held(): Promise<boolean> {
    const hold = await readFleetHold(deps.db);
    const now = isHeld(hold);
    if (now && !frozen) {
      deps.log.warn(
        hold.ok ? {} : { error: hold.error },
        hold.ok
          ? "the fleet is paused: the pulse scheduler is frozen"
          : "cannot read fleet.paused: the pulse scheduler is frozen until it can",
      );
      for (const id of [...timers.keys()]) cancel(id);
    } else if (!now && frozen) {
      deps.log.info({}, "the fleet resumed: the pulse scheduler plans again");
    }
    frozen = now;
    return now;
  }

  /**
   * Whether the orchestrator's project is paused, or its flag unreadable: its wakes are
   * then neither armed nor fired, while every other orchestrator's go on; the tick after the resume
   * plans it again. A fleet orchestrator (no project) is never held here.
   */
  async function projectHeld(agent: AgentRow): Promise<boolean> {
    if (agent.workspace_id === null) return false;
    const fact = await readProjectFact(deps.db, agent.workspace_id);
    const now = isProjectHeld(fact);
    const context = { agentId: agent.id, project: agent.workspace_id };
    if (now && !projectHolds.has(agent.id)) {
      projectHolds.add(agent.id);
      deps.log.warn(
        fact.ok ? context : { ...context, error: fact.error },
        fact.ok
          ? "the project is paused: its orchestrator does not pulse"
          : "cannot read the project's pause: its orchestrator does not pulse until it can",
      );
    } else if (!now && projectHolds.delete(agent.id)) {
      deps.log.info(
        context,
        "the project resumed: its orchestrator plans again",
      );
    }
    return now;
  }

  /** Re-reads the agent and its history, and arms its next wake; a live pulse arms nothing. */
  async function planNow(id: string): Promise<void> {
    if (stopped || parked.has(id)) return;
    if (await held()) return cancel(id);
    if (catchups.has(id) && timers.has(id)) return;
    const agent = await getAgent(deps.db, id);
    if (!agent.ok || !pulses(agent.value)) return cancel(id);
    if (await projectHeld(agent.value)) return cancel(id);
    const live = await findLivePulse(deps.db, id);
    if (!live.ok || live.value !== null) return cancel(id);
    const policy = policyOf(agent.value);
    if (!policy.success) {
      deps.log.error({ agentId: id }, "the agent's pulse policy is invalid");
      return cancel(id);
    }
    const now = deps.clock.now();
    const history = await pulseHistory(deps.db, id, now);
    if (!history.ok) {
      deps.log.error({ agentId: id, error: history.error }, "no pulse history");
      return;
    }
    const wake = nextWake(
      policy.data,
      history.value,
      bursts.get(id) ?? null,
      now,
    );
    if (wake === null) return cancel(id);
    arm(id, wake);
  }

  function arm(id: string, wake: PulseWake): void {
    const existing = timers.get(id);
    if (existing?.at === wake.at && existing.trigger === wake.trigger) return;
    existing?.cancel.abort();
    const armed: Armed = { ...wake, cancel: new AbortController() };
    timers.set(id, armed);
    const now = deps.clock.now();
    const delay = Math.max(wake.at, now + REARM_MIN_MS) - now;
    deps.clock.after(delay, armed.cancel.signal).then(
      () => {
        if (timers.get(id) === armed) timers.delete(id);
        if (wake.trigger === "catchup") catchups.delete(id);
        track(
          "pulse wake",
          queue.run(id, () => fire(id, wake)),
        );
      },
      () => undefined, // re-armed or stopped
    );
  }

  async function fire(id: string, wake: PulseWake): Promise<void> {
    // A wake armed before the pause is dropped: the tick after the resume plans the agent again.
    if (stopped || (await held())) return;
    const agent = await getAgent(deps.db, id);
    if (!agent.ok || !pulses(agent.value)) return;
    // Its project paused since the wake was armed: dropped the same way.
    if (await projectHeld(agent.value)) return;
    const before = bursts.get(id);
    handle(
      agent.value,
      await decide(rt, agent.value, wake.trigger, wake.at),
      before,
    );
  }

  /**
   * Drops the burst a pulse that ran nothing served (`before`, as the decision began). Completions
   * that came while it held the lease grew a new one, which stays to wake one follow-up.
   */
  function served(id: string, before: Burst | undefined): void {
    if (bursts.get(id) === before) bursts.delete(id);
  }

  /** What an outcome does next: a row changed, so re-plan; none did, so park until the tick. */
  function handle(
    agent: AgentRow,
    d: Result<Decision>,
    before: Burst | undefined,
  ): void {
    const id = agent.id;
    if (!d.ok) {
      deps.log.error({ agentId: id, error: d.error }, "pulse decision failed");
      parked.add(id);
      return;
    }
    switch (d.value.kind) {
      case "running":
        // Its context pack is built after this, so it sees every completion so far.
        bursts.delete(id);
        track("pulse", runPulse(rt, agent, d.value.pulse));
        return;
      case "skipped":
        served(id, before);
        plan(id);
        return;
      case "capped":
        served(id, before);
        if (d.value.created) plan(id);
        else parked.add(id);
        return;
      case "coalesced":
        return; // re-planned when that pulse ends
      case "denied":
        parked.add(id);
        return;
    }
  }

  /** The one catchup at boot (never a backlog replay), else the normal plan. */
  async function catchupNow(id: string): Promise<void> {
    if (await held()) return;
    const agent = await getAgent(deps.db, id);
    if (!agent.ok || !pulses(agent.value)) return;
    if (await projectHeld(agent.value)) return;
    const live = await findLivePulse(deps.db, id);
    if (!live.ok || live.value !== null) return;
    const policy = policyOf(agent.value);
    if (!policy.success) return;
    const now = deps.clock.now();
    const history = await pulseHistory(deps.db, id, now);
    if (!history.ok) return;
    const at = catchupAt(policy.data, history.value, now);
    if (at === null) return planNow(id);
    catchups.add(id);
    arm(id, { at, trigger: "catchup" });
  }

  function fanOutCompletion(at: number, workspaceId: string | null): void {
    for (const agent of agents.values()) {
      if (agent.pulse_mode !== "on_idle" && agent.pulse_mode !== "hybrid") {
        continue;
      }
      // Another project's completion is not this project's orchestrator's to serve.
      if (agent.workspace_id !== null && agent.workspace_id !== workspaceId) {
        continue;
      }
      bursts.set(agent.id, extendBurst(bursts.get(agent.id) ?? null, at));
      plan(agent.id);
    }
  }

  async function refreshAgents(): Promise<void> {
    const listed = await listPulseAgents(deps.db);
    if (!listed.ok) {
      deps.log.error({ error: listed.error }, "cannot list pulse agents");
      return;
    }
    const next = new Map(listed.value.map((a) => [a.id, a] as const));
    for (const id of agents.keys()) {
      if (!next.has(id)) {
        cancel(id);
        bursts.delete(id);
        projectHolds.delete(id);
      }
    }
    agents = next;
  }

  async function loadSettings(): Promise<void> {
    const loaded = await loadPulseSettings(deps.db);
    if (loaded.ok) settings = loaded.value;
    else
      deps.log.error({ error: loaded.error }, "pulse settings: defaults kept");
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await loadSettings();
      if (await held()) {
        // Frozen: leases still expire, and completions wait at the cursor for the resume.
        await sweepPulses(rt);
        return;
      }
      const polled = await completionsSince(deps.db, cursor, [
        "human_answered",
        "gate_decided",
      ]);
      if (!polled.ok) {
        deps.log.error({ error: polled.error }, "cannot poll completions");
      }
      await refreshAgents();
      for (const c of polled.ok ? polled.value : []) {
        cursor = { at: c.at, ref: c.ref };
        fanOutCompletion(c.at, c.workspace_id);
      }
      parked.clear();
      await sweepPulses(rt);
      for (const id of agents.keys()) plan(id);
    } finally {
      ticking = false;
    }
  }

  /** The next tick is armed before this one runs, so a slow tick never drifts the cadence. */
  function loop(): void {
    deps.clock.after(settings["pulse.tick_ms"], tickAbort.signal).then(
      () => {
        loop();
        track("pulse tick", tick());
      },
      () => undefined, // stopped
    );
  }

  async function settled(): Promise<void> {
    for (;;) {
      await queue.settled();
      if (work.size === 0) return;
      await Promise.all([...work]);
    }
  }

  return {
    async start() {
      await loadSettings();
      cursor = { at: deps.clock.now(), ref: "" };
      await refreshAgents();
      await sweepPulses(rt);
      // Resolves once every agent's catchup (or first wake) is armed, so boot is deterministic.
      await Promise.all(
        [...agents.keys()].map((id) => queue.run(id, () => catchupNow(id))),
      );
      loop();
    },
    async stop() {
      stopped = true;
      tickAbort.abort();
      for (const id of [...timers.keys()]) cancel(id);
      await settled();
    },
    fanOutCompletion,
    sessionEnded(e) {
      // A hand-off this end left pending was announced on its own (onHandoffPending): one wake.
      if (e.ticketId !== null && !e.handoffPending) {
        fanOutCompletion(e.at, e.workspaceId);
      }
      const pulseId = rt.sessions.get(e.sessionId);
      if (pulseId !== undefined) {
        track("settle a pulse", settleSessionPulse(rt, pulseId));
      }
    },
    runNow: (agentId) =>
      queue.run(agentId, async (): Promise<Result<RunNowResult>> => {
        const agent = await getAgent(deps.db, agentId);
        if (!agent.ok) return agent;
        if (!pulses(agent.value)) {
          return err({
            class: "validation",
            message: `agent ${agentId} does not pulse: it is not an enabled orchestrator`,
            retryable: false,
          });
        }
        if (await held()) {
          return err(
            admissionRefused({
              kind: "queue",
              gate: "fleet_paused",
              detail:
                "the fleet is paused (fleet.paused=1): no pulse runs until it resumes",
            }),
          );
        }
        const project = await readProjectFact(
          deps.db,
          agent.value.workspace_id,
        );
        if (!project.ok) return project;
        if (project.value?.paused === true) {
          return err(
            admissionRefused({
              kind: "queue",
              gate: "project_paused",
              detail: `project ${project.value.id} is paused (workspaces.paused=1): its orchestrator pulses once it resumes`,
            }),
          );
        }
        const before = bursts.get(agentId);
        const d = await decide(rt, agent.value, "manual", deps.clock.now());
        handle(agent.value, d, before);
        if (!d.ok) return d;
        return ok({
          pulse_id: d.value.kind === "denied" ? null : d.value.pulse.id,
          outcome: d.value.kind,
        });
      }),
    tick,
    settled,
    wakes: () =>
      new Map(
        [...timers].map(([id, t]) => [id, { at: t.at, trigger: t.trigger }]),
      ),
  };
}
