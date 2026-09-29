// The supervisor's conformance ports: the only ones core certify() accepts.
// Ingest on a scratch database, the run timer's watchdog, the API's /mcp and the worktree path,
// all under one run directory.
import { join } from "node:path";
import { err, ok, type Clock, type Result } from "@bayon/core";
import type { Db } from "@bayon/db";
import type { Executor } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import type { Budgets, ConformancePorts } from "@bayon/runners/conformance";
import type { Logger } from "pino";
import { frmError } from "../lifecycle/errors.js";
import type { LifecycleSettings } from "../lifecycle/settings.js";
import { JOURNAL } from "./recover.js";
import { scratchIngest } from "./ingest-port.js";
import { supervisorMcpProbe } from "./mcp-port.js";
import { supervisorWatchdog } from "./watchdog-port.js";
import { supervisorWorkspace } from "./workspace-port.js";

export interface SupervisorPortsOptions {
  /** The system of record: the probe rows, and the audit rows the API writes for them. */
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  readonly frmHome: string;
  /** This run's directory: the scratch database, the fixture mirror and the worktrees. */
  readonly dir: string;
  readonly adapter: RunnerAdapter;
  /** The models row the run certifies: its probe rows record it. */
  readonly modelId?: string;
  readonly executor: Executor;
  readonly budgets: Budgets;
  readonly mcpUrl: string;
  readonly mcpReachable: (url: string) => Promise<boolean>;
  readonly settings: LifecycleSettings;
  readonly path: string;
  readonly redact: readonly string[];
}

export interface SupervisorPorts {
  readonly ports: ConformancePorts;
  /** Ok only when the workspace freed everything it placed. */
  dispose(): Promise<Result<void>>;
}

export async function supervisorPorts(
  o: SupervisorPortsOptions,
): Promise<Result<SupervisorPorts>> {
  const ingest = await scratchIngest({
    dir: o.dir,
    clock: o.clock,
    log: o.log,
    adapter: o.adapter,
    executor: o.executor,
    redact: o.redact,
  });
  if (!ingest.ok) return ingest;
  const workspace = await supervisorWorkspace({
    root: join(o.dir, "work"),
    journal: join(o.dir, JOURNAL),
    executor: o.executor,
    exec: {
      settings: o.settings,
      clock: o.clock,
      frmHome: o.frmHome,
      path: o.path,
      log: o.log,
    },
  });
  if (!workspace.ok) {
    await ingest.value.dispose();
    return workspace;
  }
  const b = o.budgets;
  return ok({
    ports: {
      clock: o.clock,
      ingest: ingest.value.port,
      watchdog: supervisorWatchdog({
        clock: o.clock,
        ingest: ingest.value.port,
        timeout: ingest.value.timeout,
        graceMs: b.graceMs,
        stopMs: b.callMs + 2 * b.graceMs,
      }),
      mcp: supervisorMcpProbe({
        db: o.db,
        clock: o.clock,
        url: o.mcpUrl,
        reachable: o.mcpReachable,
        runnerId: o.adapter.id,
        executorId: o.executor.id,
        ...(o.modelId === undefined ? {} : { modelId: o.modelId }),
        ttlMs: b.turnMs + 2 * b.callMs,
      }),
      workspace: workspace.value,
    },
    async dispose() {
      const freed = await workspace.value.dispose().then(
        () => ok(undefined),
        (e: unknown) =>
          err(
            frmError(
              "internal",
              "the conformance workspace left sessions behind",
              String(e),
            ),
          ),
      );
      await ingest.value.dispose();
      return freed;
    },
  });
}
