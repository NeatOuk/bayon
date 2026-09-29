// runner.conformance (§15): the suite for one runner with one model on one
// executor, on the supervisor's ports, so its result can certify that (runner, executor, model). Off the claim loop, one run at a time. The report goes where
// the caller says, else <FRM_HOME>/conformance/. Only a certifiable result is stored, with its flags
// from core certify() and never from a stored one, so an incomplete run clears nothing. The run
// ends before its report is written (end-run.ts): nothing it started outlives it, and a
// run whose end left something undone still writes its report with its results, but stores nothing.
// A run with no result at all (the suite or certify() itself failed) has no report to write. With
// `compression` (spec M12) every session of the run spawns through the context proxy and
// test 17 runs; what it stores is the compression-on certificate, as the result itself says.
// A runner whose adapter does not compress on the executor is refused before anything runs.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  capsHash,
  certificationFlags,
  certify,
  containerRefusal,
  disabledExecutorRefusal,
  err,
  newId,
  ok,
  type Clock,
  type ConformanceResult,
  type FrmError,
  type JsonValue,
  type Result,
} from "@bayon/core";
import {
  getExecutor,
  getModel,
  getRunner,
  type Db,
  type ModelRow,
} from "@bayon/db";
import { storeCertification } from "@bayon/db/supervisor";
import {
  tryAcquireAll,
  type Executor,
  type Slot,
  type SlotCounter,
} from "@bayon/executors";
import { RunnerConformancePayload } from "@bayon/proto";
import type { RunnerAdapter } from "@bayon/runners";
import {
  FaultExecutor,
  LIVE_BUDGETS,
  SUITE_PEAK_SESSIONS,
  conformanceKit,
  renderReport,
  reportFileName,
  runConformance,
  type Budgets,
  type ExecutorFacts,
} from "@bayon/runners/conformance";
import type { Logger } from "pino";
import type { CommandHandler } from "../commands/claimer.js";
import { frmError } from "../lifecycle/errors.js";
import { readHealthLimits } from "../lifecycle/health.js";
import { httpReachable } from "../lifecycle/mcp.js";
import type { SecretStore } from "../lifecycle/secrets.js";
import { DEFAULT_SETTINGS, loadSettings } from "../lifecycle/settings.js";
import type { KitOf } from "./decertify.js";
import { suiteCredentials } from "./credentials.js";
import { endRun, removeRunDir } from "./end-run.js";
import { supervisorPorts } from "./ports.js";
import { recoverConformanceRuns } from "./recover.js";
import { modelSettingsOf } from "../lifecycle/model-settings.js";

export interface ConformanceCommandOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  readonly frmHome: string;
  /** Each executor with its slot counter: the suite takes the slots it needs. */
  readonly executors: ReadonlyMap<
    string,
    { readonly executor: Executor; readonly slots: SlotCounter }
  >;
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
  readonly secrets: SecretStore;
  /** PATH for the runner and git. */
  readonly path: string;
  readonly mcpUrl: string;
  readonly mcpReachable?: (url: string) => Promise<boolean>;
  readonly kits?: KitOf;
  /** Default: the live budgets. */
  readonly budgets?: Budgets;
  /** Removes a finished run's directory. Default: `rm -r`. */
  readonly removeDir?: (dir: string) => Promise<void>;
}

export interface ConformanceCommand {
  readonly handler: CommandHandler<RunnerConformancePayload>;
  /** Refuses new runs, then waits for the one in flight. */
  stop(): Promise<void>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const detailNumber = (v: JsonValue | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const detailString = (v: JsonValue | undefined): string | null =>
  typeof v === "string" && v !== "" ? v : null;

/** The executor cannot take the suite now: nothing ran, and a later run may. */
const refused = (message: string, cause: JsonValue): FrmError => ({
  class: "admission_refused",
  message,
  retryable: true,
  cause,
});

/**
 * The kill switch (§6.1): `executors.enabled = 0` refuses the suite, as admission
 * refuses a session spawn on the same row and with the same gate. Read here, at the moment the run
 * would start, and not when the command was accepted: the API checks the row too, but a run can
 * wait minutes behind another, and `frm executor disable` during that wait must still be obeyed.
 * The row is the authority, never the wired map — a disabled executor stays wired and healthy.
 */
/**
 * The payload's model: an active models row of the payload's runner. The API checks it
 * too, but a model can be retired by a registration while the command waits.
 */
async function modelToRun(
  db: Db,
  p: RunnerConformancePayload,
): Promise<Result<ModelRow>> {
  const model = await getModel(db, p.model_id);
  if (!model.ok) return model;
  if (model.value.runner_id !== p.runner_id || model.value.active !== 1) {
    return err(
      frmError(
        "validation",
        `model ${p.model_id} is not an active model of runner ${p.runner_id}`,
      ),
    );
  }
  return ok(model.value);
}

async function enabledNow(db: Db, executorId: string): Promise<Result<void>> {
  const row = await getExecutor(db, executorId);
  if (!row.ok) return row;
  const refusal = disabledExecutorRefusal({
    executorId,
    enabled: row.value.enabled === 1,
  });
  return refusal === null ? ok(undefined) : err(refusal);
}

/**
 * Pre-flight (§10): the executor's own health check, judged against the fleet's
 * limits as the health pass judges it, which also (re)starts a container's tunnel and
 * gateway (test 11 needs them), then the suite's peak *taken*, not merely counted.
 *
 * The claim is what makes the shared-host slot cap hold: the suite spawns its sessions straight
 * through the executor, never through admission, so until it held slots a run could start on a
 * ctr-lab already full of sessions and break the 2-slot cap. Reading free slots and then spawning
 * left a window between the two; `tryAcquireAll` closes it, and refuses all-or-nothing so a refused
 * run strands nothing. Returns the facts the report shows, and the claim for the caller to release.
 */
async function preflight(
  db: Db,
  executor: Executor,
  slots: SlotCounter,
): Promise<Result<{ facts: ExecutorFacts; claim: Slot }>> {
  const limits = await readHealthLimits(db);
  if (!limits.ok) return limits;
  const report = await executor.health(limits.value);
  if (!report.healthy) {
    return err(
      refused(`executor ${executor.id} is unhealthy: conformance not started`, {
        executor: executor.id,
        health: report.detail,
      }),
    );
  }
  const facts: ExecutorFacts = {
    rttMs: detailNumber(report.detail["rtt_ms"]),
    image: detailString(report.detail["image"]),
  };
  const claim = tryAcquireAll(slots, SUITE_PEAK_SESSIONS);
  if (claim === null) {
    const { slots: total, used } = executor.capacity();
    return err(
      refused(
        `executor ${executor.id} has ${total - used} of ${total} slots free; the suite needs ${SUITE_PEAK_SESSIONS}`,
        {
          executor: executor.id,
          slots: total,
          used,
          needed: SUITE_PEAK_SESSIONS,
        },
      ),
    );
  }
  return ok({ facts, claim });
}

export function conformanceCommand(
  o: ConformanceCommandOptions,
): ConformanceCommand {
  const kits = o.kits ?? conformanceKit;
  /** What a crashed run left on its executor, freed by its journal. Never rejects. */
  const recover = () =>
    recoverConformanceRuns({
      frmHome: o.frmHome,
      executors: new Map(
        [...o.executors].map(([id, e]) => [id, e.executor] as const),
      ),
      log: o.log,
    }).catch((e: unknown) => {
      o.log.error(
        { err: String(e) },
        "the conformance recovery sweep failed: the next run retries",
      );
    });
  // The sweep is the queue's first job, so no run is in flight while it looks.
  let queue: Promise<unknown> = recover();
  let stopping = false;

  /**
   * Writes the report, then stores the result if it certifies and the run ended cleanly: a run
   * whose `teardown` left something undone stores and clears nothing, whatever its tests say.
   */
  async function persist(
    r: ConformanceResult,
    model: ModelRow,
    reportDir: string,
    facts: ExecutorFacts | undefined,
    teardown: readonly string[],
  ): Promise<Result<JsonValue>> {
    const reportPath = join(reportDir, reportFileName(r));
    try {
      await mkdir(reportDir, { recursive: true });
      await writeFile(reportPath, renderReport(r, facts, teardown));
    } catch (e) {
      return err(frmError("internal", `cannot write ${reportPath}`, String(e)));
    }
    const stored = r.summary.certifiable && teardown.length === 0;
    const flags = certificationFlags(r);
    if (stored) {
      const written = await storeCertification(o.db, {
        runner_id: r.runner_id,
        executor_id: r.executor.id,
        model_id: model.id,
        // The result's own (certify() recomputed it), never the request's.
        compression: r.compression !== null,
        model: model.model,
        runner_version: r.runner_version,
        suite_version: r.suite_version,
        kit_hash: r.kit_hash,
        caps_hash: await capsHash(r.caps),
        result_json: JSON.stringify(r),
        report_path: reportPath,
        ...flags,
      });
      if (!written.ok) return written;
    }
    o.log.info(
      {
        runner: r.runner_id,
        executor: r.executor.id,
        model: model.id,
        compression: r.compression !== null,
        reportPath,
        stored,
        summary: r.summary,
        teardown,
      },
      "conformance finished",
    );
    return ok({
      runner_id: r.runner_id,
      executor_id: r.executor.id,
      model_id: model.id,
      model: model.model,
      runner_version: r.runner_version,
      report_path: reportPath,
      stored,
      // What the row's passed_at now holds: certified only when it is set.
      passed_at: stored ? flags.passed_at : null,
      summary: r.summary,
      teardown: [...teardown],
      compression: r.compression !== null,
    });
  }

  /**
   * A runner that cannot run in a container is refused on one before anything runs: no
   * recovery sweep, no pre-flight, no wait behind a run in flight. The rule reads the runner row's
   * defaults, where its adapter declares its container readiness (Invariant 1).
   */
  async function containerReady(
    p: RunnerConformancePayload,
  ): Promise<Result<void>> {
    const executor = o.executors.get(p.executor_id)?.executor;
    // Not wired, or no container: run() says so, or runs it.
    if (executor === undefined || executor.kind !== "container") {
      return ok(undefined);
    }
    const runner = await getRunner(o.db, p.runner_id);
    if (!runner.ok) return runner;
    const refusal = containerRefusal({
      runnerId: p.runner_id,
      defaults: parseJson(runner.value.defaults_json),
      executorId: p.executor_id,
      executorKind: executor.kind,
    });
    if (refusal === null) return ok(undefined);
    o.log.warn(
      { runner: p.runner_id, executor: p.executor_id, cause: refusal.cause },
      "conformance refused: the runner cannot run in a container",
    );
    return err(refusal);
  }

  /**
   * A compression run of a runner whose adapter does not declare it on the executor (spec M12) is
   * refused before anything runs, as a container refusal is: the suite would refuse it anyway, but
   * only after the recovery sweep, the pre-flight and the slots.
   */
  function compressionReady(p: RunnerConformancePayload): Result<void> {
    if (p.compression !== true) return ok(undefined);
    const adapter = o.adapters.get(p.runner_id);
    const executor = o.executors.get(p.executor_id)?.executor;
    // Not loaded or not wired: run() says so.
    if (adapter === undefined || executor === undefined) return ok(undefined);
    if (adapter.compressesContext?.(executor) === true) return ok(undefined);
    o.log.warn(
      { runner: p.runner_id, executor: p.executor_id },
      "conformance refused: the runner does not compress context on this executor",
    );
    return err(
      frmError(
        "validation",
        `runner ${p.runner_id} does not compress context on executor ${p.executor_id} (a ${executor.kind} executor): its sessions there run uncompressed on their normal certificate, so there is nothing to certify with --compression`,
      ),
    );
  }

  async function run(p: RunnerConformancePayload): Promise<Result<JsonValue>> {
    await recover(); // what a crashed run left, before this one places more
    const adapter = o.adapters.get(p.runner_id);
    if (adapter === undefined) {
      return err(
        frmError("not_found", `no runner adapter ${p.runner_id} is loaded`),
      );
    }
    const kit = kits(p.runner_id);
    if (!kit.ok) return kit;
    const model = await modelToRun(o.db, p);
    if (!model.ok) return model;
    const wired = o.executors.get(p.executor_id);
    if (wired === undefined) {
      return err(
        frmError("not_found", `executor ${p.executor_id} is not wired here`),
      );
    }
    const { executor } = wired;
    // Before the health check and before any slot is taken: a run on an executor the operator has
    // taken out of service neither starts it up nor strands its capacity.
    const enabled = await enabledNow(o.db, p.executor_id);
    if (!enabled.ok) {
      o.log.warn(
        { runner: p.runner_id, executor: p.executor_id, error: enabled.error },
        "conformance refused: the executor is disabled",
      );
      return enabled;
    }
    const ready = await preflight(o.db, executor, wired.slots);
    if (!ready.ok) return ready;
    const { facts, claim } = ready.value;
    try {
      return await runHolding(
        p,
        adapter,
        kit.value,
        model.value,
        executor,
        facts,
      );
    } finally {
      // Held for the run's whole duration, whatever ends it: a throw past endRun would otherwise
      // leave the executor permanently short of slots until the supervisor restarted.
      claim.release();
    }
  }

  /** The run itself, with the suite's slots already held by `run` above. */
  async function runHolding(
    p: RunnerConformancePayload,
    adapter: RunnerAdapter,
    kit: Parameters<typeof runConformance>[0]["kit"],
    model: ModelRow,
    executor: Executor,
    facts: ExecutorFacts,
  ): Promise<Result<JsonValue>> {
    // As a session takes them (credentials.ts), with the executor's own PATH where its programs
    // are not this host's (a container's image).
    const credentials = await suiteCredentials(
      o,
      p.runner_id,
      executor.envPath ?? o.path,
    );
    if (!credentials.ok) {
      o.log.warn(
        {
          runner: p.runner_id,
          executor: p.executor_id,
          error: credentials.error,
        },
        "conformance refused: the runner's credentials cannot be resolved",
      );
      return credentials;
    }
    const { env, redact, grantedLogin } = credentials.value;
    // The model's own adapter settings: certified as a session of it would run.
    const ownSettings = modelSettingsOf(model);
    if (!ownSettings.ok) return ownSettings;
    const settings = await loadSettings(o.db);
    const budgets = o.budgets ?? LIVE_BUDGETS;
    const dir = join(o.frmHome, "conformance", "runs", newId(o.clock.now()));
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      return err(frmError("internal", `cannot create ${dir}`, String(e)));
    }
    const ports = await supervisorPorts({
      db: o.db,
      clock: o.clock,
      log: o.log,
      frmHome: o.frmHome,
      dir,
      adapter,
      modelId: model.id,
      executor,
      budgets,
      mcpUrl: o.mcpUrl,
      mcpReachable: o.mcpReachable ?? httpReachable,
      settings: settings.ok ? settings.value : DEFAULT_SETTINGS,
      path: o.path,
      redact,
    });
    if (!ports.ok) return ports;
    const { ports: suitePorts, dispose } = ports.value;
    o.log.info(
      {
        runner: p.runner_id,
        executor: p.executor_id,
        model: model.id,
        compression: p.compression === true,
      },
      "conformance started",
    );
    // Every process the suite launches goes through it, so the run's end can find each.
    const fault = new FaultExecutor(executor);
    let drafted: Result<ConformanceResult>;
    try {
      drafted = await runConformance(
        {
          adapter,
          kit,
          model: model.model,
          ...ownSettings.value,
          executor: fault,
          env,
          ...(grantedLogin === undefined ? {} : { grantedLogin }),
        },
        suitePorts,
        { budgets, ...(p.compression === true ? { compression: true } : {}) },
      );
    } catch (e) {
      // The suite keeps its results so far when its harness fails: a throw is a bug in it.
      drafted = err(
        frmError("internal", "the conformance suite threw", String(e)),
      );
    }
    const teardown = await endRun({
      fault,
      clock: o.clock,
      log: o.log,
      dir,
      dispose,
      killMs: budgets.callMs,
      removeDir: o.removeDir ?? removeRunDir,
    });
    if (!drafted.ok) return drafted;
    const result = certify(drafted.value); // never trusted: recomputed here too
    if (!result.ok) return result;
    return persist(
      result.value,
      model,
      p.report_dir ?? join(o.frmHome, "conformance"),
      facts,
      teardown,
    );
  }

  return {
    handler: {
      type: "runner.conformance",
      payload: RunnerConformancePayload,
      background: true,
      // Minutes of real spend on a real runner: an operator re-runs it.
      idempotent: false,
      handle(p) {
        if (stopping) {
          return Promise.resolve(
            err(
              frmError(
                "interrupted",
                "the supervisor is stopping: runner.conformance was not started",
              ),
            ),
          );
        }
        // A refusal answers at once; an accepted run waits for the one before it, and the next
        // waits for both, so a refusal never lets a run overtake another.
        const before = queue;
        const compressing = compressionReady(p);
        const job = compressing.ok
          ? containerReady(p).then((ready) =>
              ready.ok ? before.then(() => run(p)) : ready,
            )
          : Promise.resolve(compressing);
        queue = Promise.allSettled([before, job]);
        return job;
      },
    },
    async stop() {
      stopping = true;
      await queue;
    },
  };
}
