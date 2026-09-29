// probe.run (§11.1; proto ProbeRunPayload): re-run one probe within a pulse, as a new pulse_checks
// row. The handler checks the pulse and the probe and returns at once; the check is recorded when
// the probe ends, since a shell probe may run its whole timeout_ms and a claimer handler must
// settle fast.
import { err, ok } from "@bayon/core";
import { getProbe, getPulse, type Db } from "@bayon/db";
import { insertPulseChecks } from "@bayon/db/supervisor";
import { ProbeRunPayload } from "@bayon/proto";
import type { Logger } from "pino";
import type { CommandHandler } from "../commands/claimer.js";
import type { ProbeRunner } from "./probes.js";

export interface ProbeCommand {
  readonly handler: CommandHandler<ProbeRunPayload>;
  /** Resolves once every re-run started so far is recorded, or its failure logged. */
  idle(): Promise<void>;
  /** Cancels the re-runs in flight (each records an interrupted check), then waits for them. */
  stop(): Promise<void>;
}

export interface ProbeCommandOptions {
  readonly db: Db;
  readonly runner: ProbeRunner;
  readonly log: Logger;
}

export function probeRunCommand(o: ProbeCommandOptions): ProbeCommand {
  const abort = new AbortController();
  let inflight: ReadonlySet<Promise<void>> = new Set();

  async function rerun(p: ProbeRunPayload): Promise<void> {
    const results = await o.runner.run({
      pulseId: p.pulse_id,
      names: [p.probe],
      signal: abort.signal,
    });
    const recorded = results.ok
      ? await insertPulseChecks(o.db, p.pulse_id, results.value)
      : results;
    if (!recorded.ok) {
      o.log.error(
        { pulse: p.pulse_id, probe: p.probe, error: recorded.error },
        "probe.run: the check was not recorded",
      );
    }
  }

  /** Until nothing is in flight: a job queued while waiting is waited for too. */
  const idle = async () => {
    while (inflight.size > 0) await Promise.all([...inflight]);
  };

  /** After stop() no re-run starts: the claimer may still hand over a command while the
   * supervisor shuts down, and its check could no longer be recorded. */
  const stopping = () =>
    err({
      class: "interrupted" as const,
      message: "the supervisor is stopping: probe.run was not started",
      retryable: true,
    });

  return {
    handler: {
      type: "probe.run",
      payload: ProbeRunPayload,
      // Its pulse's orchestrator died with a restart: a re-run writes a check nobody reads.
      idempotent: false,
      async handle(p) {
        if (abort.signal.aborted) return stopping();
        const pulse = await getPulse(o.db, p.pulse_id);
        if (!pulse.ok) return pulse;
        const probe = await getProbe(o.db, p.probe);
        if (!probe.ok) return probe;
        if (probe.value.enabled !== 1) {
          return err({
            class: "validation",
            message: `probe ${p.probe} is disabled`,
            retryable: false,
          });
        }
        if (abort.signal.aborted) return stopping();
        const job = rerun(p).catch((thrown: unknown) => {
          o.log.error(
            { pulse: p.pulse_id, probe: p.probe, error: String(thrown) },
            "probe.run: the re-run threw",
          );
        });
        inflight = new Set([...inflight, job]);
        void job.finally(() => {
          inflight = new Set([...inflight].filter((j) => j !== job));
        });
        return ok({ pulse_id: p.pulse_id, probe: p.probe, queued: true });
      },
    },
    idle,
    async stop() {
      abort.abort();
      await idle();
    },
  };
}
