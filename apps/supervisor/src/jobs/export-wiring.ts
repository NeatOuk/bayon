// Wires the exporter into a running supervisor: its boot-row registration, the `export.run`
// claimer handler, the interval timer, and -- the piece a code review found missing -- the
// manifest -> ticket_exports reconciler subscribed on `ingest.onTerminal`. Pulled out of main.ts
// so it is testable against a real `startSupervisor()` (export-wiring.test.ts): without the
// `onTerminal` subscription this function installs, an export run's terminal commits but
// `ticket_exports` is never written and `export_failed` never appears.
import { newId, type Clock, type Result } from "@bayon/core";
import type { RunnerAdapter } from "@bayon/runners";
import type { Logger } from "pino";
import { upsertBootRows } from "../boot.js";
import type { Supervisor } from "../supervisor.js";
import {
  EXPORTER_AGENT_ID,
  EXPORTER_PROMPT,
  EXPORTER_ROLE,
  EXPORTER_RUN_CLASS,
} from "./export-agent.js";
import { exportRunHandler } from "./export-command.js";
import { spawnExportIfIdle } from "./export-guard.js";
import {
  createExportScheduler,
  type ExportScheduler,
} from "./export-scheduler.js";
import { loadExportSettings } from "./export-settings.js";
import { handleExportTerminal } from "./export-terminal.js";

export interface ExportWiringOptions {
  readonly supervisor: Supervisor;
  readonly log: Logger;
  readonly clock: Clock;
  readonly exportAdapter: RunnerAdapter;
}

export interface ExportWiring {
  /** Stops the interval timer and unsubscribes from ingest.onTerminal. Idempotent. */
  stop(): void;
}

/** Starts a fresh exporter session via the lifecycle's internal spawn path -- no `commands` row:
 * the supervisor owns sessions, and Invariant 5 governs only who may *insert* a command. */
export function spawnExporter(
  supervisor: Supervisor,
  clock: Clock,
): () => Promise<Result<string>> {
  return () =>
    supervisor.lifecycle.spawn({
      session_id: newId(clock.now()),
      agent_id: EXPORTER_AGENT_ID,
      role: EXPORTER_ROLE,
      run_class: EXPORTER_RUN_CLASS,
      // Without a prompt the spawn starts no run, and the job never hears `go`.
      prompt: EXPORTER_PROMPT,
    });
}

export async function wireExporter(
  o: ExportWiringOptions,
): Promise<ExportWiring> {
  const { supervisor, log, clock, exportAdapter } = o;

  // The exporter's runner+model rows: registrations() only knows about packages/runners' own
  // FACTORIES map (Invariant 1), so its adapter's rows go in with a second, equally idempotent
  // upsertBootRows call (amendment 4).
  const registered = await upsertBootRows(supervisor.db, {
    registrations: [exportAdapter.registration()],
  });
  if (!registered.ok) {
    log.error(
      { error: registered.error },
      "cannot register the exporter's runner row",
    );
  }

  // The manifest -> ticket_exports reconciler (design doc §4). `onTerminal` fires for every
  // session's terminal, runner-written or supervisor-synthesized alike; the handler itself filters
  // to the exporter's own sessions. Without this line, ticket_exports and export_failed never see
  // a write (the CRITICAL this file exists to make untestable-to-forget).
  const unsubscribe = supervisor.ingest.onTerminal(
    (t) =>
      void handleExportTerminal(
        { db: supervisor.db, clock, log, exporterAgentId: EXPORTER_AGENT_ID },
        t,
      ),
  );

  // `export.run` (contract 5/6): the API inserts the command, this claims it.
  supervisor.claimer.register(
    exportRunHandler({
      db: supervisor.db,
      agentId: EXPORTER_AGENT_ID,
      spawn: spawnExporter(supervisor, clock),
    }),
  );

  // The interval timer (design doc §6): off unless an operator sets exports.interval_ms > 0.
  const settings = await loadExportSettings(supervisor.db);
  let scheduler: ExportScheduler | undefined;
  if (!settings.ok) {
    log.error(
      { error: settings.error },
      "cannot load export settings; the interval timer stays off",
    );
  } else {
    scheduler = createExportScheduler({
      clock,
      intervalMs: settings.value["exports.interval_ms"],
      tick: async () => {
        const result = await spawnExportIfIdle({
          db: supervisor.db,
          agentId: EXPORTER_AGENT_ID,
          spawn: spawnExporter(supervisor, clock),
        });
        if (!result.ok) {
          log.error({ error: result.error }, "export timer: spawn failed");
        }
      },
      onError: (e) => log.error({ err: String(e) }, "export timer tick threw"),
    });
    scheduler.start();
  }

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      scheduler?.stop();
      unsubscribe();
    },
  };
}
