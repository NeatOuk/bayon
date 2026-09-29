// The pulse layer's seams: the probe runner, the context pack
//, the gate M4 replaces, and what the layer asks of the lifecycle.
import type { Clock, PulseSkipReason, PulseTrigger, Result } from "@bayon/core";
import type { Db } from "@bayon/db";
import type {
  InternalSpawn,
  Log,
  SessionEnded,
  StopMode,
} from "../lifecycle/index.js";
import type { ContextPackBuilder } from "./context-pack.js";
import type { ProbeRunner } from "./probes.js";

export type { ProbeResult, ProbeRunner } from "./probes.js";
/**
 * TEMPLATES.pulse's section inputs for run 1. Compile, cuts and the cap stay in
 * startRun, so the pack cannot bypass pre-flight.
 */
export type { ContextPackBuilder } from "./context-pack.js";

/** Deny writes no row, unless `record` names the skip reason for one. */
export type GateDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly record?: PulseSkipReason };

/**
 * Called before every pulse, manual included. M2's is the daily budget
 * (gate.ts); M4 replaces it: pause freezes the scheduler, a budget breach asks a human.
 */
export type PulseGate = (a: {
  readonly agentId: string;
  readonly trigger: PulseTrigger;
  readonly now: number;
}) => Promise<GateDecision>;

/** What the pulse layer asks of the lifecycle. */
export interface PulseLifecycle {
  spawnInternal(spec: InternalSpawn): Promise<Result<string>>;
  stop(sessionId: string, mode: StopMode): Promise<void>;
}

export interface PulseDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Log;
  readonly lifecycle: PulseLifecycle;
  readonly probes: ProbeRunner;
  readonly pack: ContextPackBuilder;
  readonly gate: PulseGate;
  /** MCP tools a pulse session must mount; wirePulse's default is pulse_report. */
  readonly requireTools: readonly string[];
}

export type { SessionEnded };
