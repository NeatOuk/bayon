// Wires the gate engine into a running supervisor: the gate.run handler,
// then the restart sweep and the poll. After lifecycle.boot(), whose reconciler pass has already
// ended every reviewer that died while the supervisor was down (never adopted: H3).
import type { Clock } from "@bayon/core";
import type { Executor } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import type { Log } from "../lifecycle/index.js";
import type { SecretStore } from "../lifecycle/secrets.js";
import type { Supervisor } from "../supervisor.js";
import { createGateEngine, type GateEngine } from "./engine.js";

export interface GateWiringOptions {
  readonly supervisor: Supervisor;
  readonly log: Log;
  readonly clock: Clock;
  readonly frmHome: string;
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
  readonly executors: ReadonlyMap<string, Executor>;
  /** PATH for git. */
  readonly path: string;
  /** The host secret store: a private origin's forge token. Omitting it silently
   * means no forge token for private-origin fetches, not an error. */
  readonly secrets?: SecretStore;
}

export interface GateWiring {
  readonly engine: GateEngine;
  /** Stops the poll; kills nothing. Idempotent. */
  stop(): Promise<void>;
}

export async function wireGates(o: GateWiringOptions): Promise<GateWiring> {
  const engine = createGateEngine({
    db: o.supervisor.db,
    clock: o.clock,
    log: o.log,
    frmHome: o.frmHome,
    lifecycle: o.supervisor.lifecycle,
    adapters: o.adapters,
    executors: o.executors,
    path: o.path,
    ...(o.secrets === undefined ? {} : { secrets: o.secrets }),
  });
  o.supervisor.claimer.register(engine.handler);
  await engine.start();
  let stopping: Promise<void> | undefined;
  return { engine, stop: () => (stopping ??= engine.stop()) };
}
