// The supervisor daemon: `FRM_HOME=… node dist/main.js`. SIGINT/SIGTERM shut down gracefully
// (pending events commit, children keep running); a fatal ingest error exits 1.
import { mkdirSync, readFileSync } from "node:fs";
import { systemClock } from "@bayon/core";
import type { Db } from "@bayon/db";
import {
  hostSecrets,
  LocalExecutor,
  mcpUrl as installMcpUrl,
  SlotCounter,
} from "@bayon/executors";
import { loadAdapter, RUNNER_IDS, type RunnerAdapter } from "@bayon/runners";
import { pino, type Logger } from "pino";
import { z } from "zod";
import {
  LOCAL_EXECUTOR_ID,
  LOCAL_EXECUTOR_SLOTS,
  assertJobRunners,
} from "./boot.js";
import {
  conformanceCommand,
  type ConformanceCommand,
} from "./conformance/command.js";
import { localDiskPaths } from "./lifecycle/disk-paths.js";
import type { SecretStore } from "./lifecycle/secrets.js";
import { wireGates, type GateWiring } from "./gates/wiring.js";
import { wireBackups, type BackupWiring } from "./jobs/backup-wiring.js";
import {
  createUpdateCheckScheduler,
  loadUpdateCheckHours,
  runUpdateCheckPass,
  type UpdateCheckScheduler,
} from "./jobs/update-check.js";
import { wireExporter, type ExportWiring } from "./jobs/export-wiring.js";
import {
  exportAdapter,
  JOB_ADAPTERS,
  JOB_RUNNERS,
  lintAdapter,
  qaAdapter,
  parityAdapter,
} from "./jobs/job-adapters.js";
import { registerLintRunner } from "./jobs/lint-wiring.js";
import { registerQaRunner } from "./jobs/qa-wiring.js";
import { registerParityRunner } from "./jobs/parity-wiring.js";
import { lifecycleFactory, type ExecutorSlots } from "./lifecycle/index.js";
import {
  humanDestination,
  LogFormat,
  LogLevel,
  logSetup,
} from "./log-output.js";
import { homeTag, socketPath } from "./paths.js";
import { createPlacement, egressHostsOf, type Placement } from "./placement.js";
import { probeRunCommand, type ProbeCommand } from "./pulse/probe-command.js";
import { createProbeRunner } from "./pulse/probes.js";
import { wirePulse, type PulseWiring } from "./pulse/wiring.js";
import {
  startSupervisor,
  type LifecycleFactory,
  type Supervisor,
} from "./supervisor.js";

/** Every registry adapter, and the exporter's. */
function loadAdapters(log: Logger): ReadonlyMap<string, RunnerAdapter> {
  const adapters = new Map<string, RunnerAdapter>();
  for (const id of RUNNER_IDS) {
    const adapter = loadAdapter(id);
    if (adapter.ok) adapters.set(id, adapter.value);
    else
      log.error({ runner: id, error: adapter.error }, "cannot load a runner");
  }
  // Not in packages/runners' own registry (Invariant 1: that file never names anything outside
  // packages/runners) -- these are supervisor-level jobs, so they are wired here instead.
  for (const job of JOB_ADAPTERS) adapters.set(job.id, job);
  return adapters;
}

/** The lifecycle and its host side: the executors its rows name, the adapters, the secret store. */
function processLifecycle(
  adapters: ReadonlyMap<string, RunnerAdapter>,
  mcpUrl: string,
  local: ExecutorSlots,
  placement: Placement,
  tag: string,
  secrets: SecretStore,
  retentionNow: (reason: string) => Promise<void>,
): LifecycleFactory {
  return lifecycleFactory({
    executors: new Map([[LOCAL_EXECUTOR_ID, local]]),
    loadExecutors: (db) => placement.load(db),
    adapters,
    mcpUrl,
    secrets,
    homeTag: tag,
    jobRunners: JOB_RUNNERS,
    retentionNow,
  });
}

const Env = z.object({
  FRM_HOME: z.string().min(1),
  FRM_DB: z.string().min(1).optional(),
  /** The API's /mcp that session runners call; absent, this home's API's. */
  FRM_MCP_URL: z.url().optional(),
  /** Absent: `info` to a file, `warn` at a terminal (log-output.ts). */
  FRM_LOG_LEVEL: LogLevel.optional(),
  /** Absent: human lines at a terminal, JSON otherwise. */
  FRM_LOG_FORMAT: LogFormat.optional(),
});
const PackageJson = z.object({ version: z.string().min(1) });

async function main(): Promise<void> {
  const env = Env.safeParse(process.env);
  const output = logSetup(
    env.success ? env.data : {},
    process.stdout.isTTY === true,
  );
  const log =
    output.format === "human"
      ? pino(
          { name: "supervisor", level: output.level },
          humanDestination((text) => process.stdout.write(text)),
        )
      : pino({ name: "supervisor", level: output.level });
  /** A start that fails: the log record, and in JSON mode one plain line on stderr too. */
  const cannotStart = (
    what: string,
    error: { readonly message: string },
    code: number,
  ): void => {
    log.fatal({ error }, what);
    if (output.format === "json")
      process.stderr.write(`supervisor: ${what}: ${error.message}\n`);
    process.exitCode = code;
  };
  if (!env.success) {
    cannotStart(
      "set FRM_HOME to start the supervisor",
      { message: z.prettifyError(env.error) },
      2,
    );
    return;
  }
  // CI and the smokes set FRM_SECRET_<NAME>; an operator keeps secrets in the Keychain, or, with
  // FRM_SECRET_STORE=file on a Linux host, in read-only files.
  // The Keychain service is this FRM_HOME's own: `foreman` for the default home only.
  const secrets = hostSecrets(process.env);
  if (!secrets.ok) {
    cannotStart("the host secret store is refused", secrets.error, 2);
    return;
  }
  const pkg = PackageJson.safeParse(
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ),
  );
  const version = pkg.success ? pkg.data.version : "unknown";
  // The home exists before its tag is taken: the tag hashes its real path.
  try {
    mkdirSync(env.data.FRM_HOME, { recursive: true, mode: 0o700 });
  } catch (e) {
    cannotStart("cannot create FRM_HOME", { message: String(e) }, 1);
    return;
  }
  const tag = homeTag(env.data.FRM_HOME);
  const jobs = assertJobRunners(JOB_RUNNERS, RUNNER_IDS);
  if (!jobs.ok) {
    cannotStart("the supervisor could not start", jobs.error, 1);
    return;
  }

  // onFatal can fire before startSupervisor (or wireExporter) returns, so exit reads them late.
  const current: {
    supervisor?: Supervisor;
    exporter?: ExportWiring;
    probes?: ProbeCommand;
    pulse?: PulseWiring;
    conformance?: ConformanceCommand;
    gates?: GateWiring;
    backups?: BackupWiring;
    updateCheck?: UpdateCheckScheduler;
  } = {};
  // One local executor: the lifecycle's sessions and the shell probes both run through it. Its
  // health measures FRM_HOME/work and every repo's mirror; the repos come from the db, which the
  // lifecycle factory hands over before boot's first health pass. It finds this home's orphans by
  // the tag every session's environment carries.
  let lifecycleDb: Db | undefined;
  const slots = new SlotCounter(LOCAL_EXECUTOR_SLOTS);
  const local = {
    executor: new LocalExecutor({
      id: LOCAL_EXECUTOR_ID,
      slots,
      diskPaths: localDiskPaths(env.data.FRM_HOME, () => lifecycleDb),
      homeTag: tag,
    }),
    slots,
  };
  // FRM_MCP_URL, else this home's own API (its install.json, FRM_API_PORT): never the default
  // install's port by accident. With neither, http://127.0.0.1:3010/mcp as before.
  const resolvedMcp = installMcpUrl(process.env);
  if (!resolvedMcp.ok) {
    cannotStart("the supervisor could not start", resolvedMcp.error, 2);
    return;
  }
  const mcpUrl = resolvedMcp.value;
  const adapters = loadAdapters(log);
  // Every executor row this process can run: container executors over ssh, each holding
  // its /mcp tunnel, beside the local one. The lifecycle loads them at boot; exit closes them.
  const placement = createPlacement({
    frmHome: env.data.FRM_HOME,
    mcpUrl,
    local,
    egressHosts: egressHostsOf(adapters),
    log: log.child({ component: "placement" }),
    homeTag: tag,
  });
  let exiting = false;
  const exit = async (code: number) => {
    if (exiting) return;
    exiting = true;
    current.exporter?.stop();
    // A backup in progress finishes (and records its row) before the database closes.
    await current.backups?.stop();
    await current.updateCheck?.stop();
    await current.gates?.stop();
    await current.pulse?.stop();
    await current.probes?.stop();
    await current.conformance?.stop();
    await current.supervisor?.shutdown();
    await placement.close();
    process.exit(code);
  };
  const started = await startSupervisor({
    home: env.data.FRM_HOME,
    dbPath: env.data.FRM_DB,
    clock: systemClock,
    log,
    version,
    // The handlers below register after the claimer starts: until wired(), a command of a type
    // not registered yet (runner.conformance posted at once, a requeued gate.run) waits for it.
    wiring: true,
    lifecycle: (deps) => {
      lifecycleDb = deps.db;
      return processLifecycle(
        adapters,
        mcpUrl,
        local,
        placement,
        tag,
        secrets.value.spawn,
        // The watchdog's low-disk rule: the backups are wired after boot, so read late.
        (reason) => current.backups?.retentionNow(reason) ?? Promise.resolve(),
      )(deps);
    },
    onFatal: () => void exit(1),
  });
  if (!started.ok) {
    cannotStart("the supervisor could not start", started.error, 1);
    await placement.close();
    return;
  }
  current.supervisor = started.value;

  // Runner+model rows, the export.run claimer handler, the manifest -> ticket_exports reconciler
  // and the interval timer -- all after lifecycle.boot() (already run, inside startSupervisor),
  // alongside the claimer.
  current.exporter = await wireExporter({
    supervisor: started.value,
    log,
    clock: systemClock,
    exportAdapter,
  });

  // The parity job's runner row. Nothing else to wire: the gate engine starts it.
  const parityRegistered = await registerParityRunner(
    started.value.db,
    parityAdapter,
  );
  if (!parityRegistered.ok) {
    log.error(
      { error: parityRegistered.error },
      "cannot register the parity checker's runner row",
    );
  }

  // The lint job's runner row, the same: the gate engine starts it.
  const lintRegistered = await registerLintRunner(
    started.value.db,
    lintAdapter,
  );
  if (!lintRegistered.ok) {
    log.error(
      { error: lintRegistered.error },
      "cannot register the lint checker's runner row",
    );
  }

  // The QA job's runner row, the same: the gate engine starts it.
  const qaRegistered = await registerQaRunner(started.value.db, qaAdapter);
  if (!qaRegistered.ok) {
    log.error(
      { error: qaRegistered.error },
      "cannot register the QA checker's runner row",
    );
  }

  // The probe runner (§10.2): the pulse scheduler runs it each pulse; probe.run re-runs one check.
  const probeRunner = createProbeRunner({
    db: started.value.db,
    clock: systemClock,
    executor: local.executor,
    slots: local.slots,
    home: env.data.FRM_HOME,
    path: process.env["PATH"] ?? "",
  });
  current.probes = probeRunCommand({
    db: started.value.db,
    runner: probeRunner,
    log,
  });
  started.value.claimer.register(current.probes.handler);

  // The pulse scheduler (§9.7): pulse.run and pulse.report, the boot sweep and catchup, the tick.
  current.pulse = await wirePulse({
    supervisor: started.value,
    log,
    clock: systemClock,
    frmHome: env.data.FRM_HOME,
    probeRunner,
  });

  // runner.conformance (§15): the suite on the supervisor's ports, off the claim loop; on any
  // executor the lifecycle loaded at boot.
  current.conformance = conformanceCommand({
    db: started.value.db,
    clock: systemClock,
    log: log.child({ component: "conformance" }),
    frmHome: env.data.FRM_HOME,
    executors: placement.loaded(),
    adapters,
    secrets: secrets.value.spawn,
    path: process.env["PATH"] ?? "",
    mcpUrl,
  });
  started.value.claimer.register(current.conformance.handler);

  // The gate engine (M3-h): gate.run, the restart sweep, the poll; reviewers through the lifecycle.
  current.gates = await wireGates({
    supervisor: started.value,
    log: log.child({ component: "gates" }),
    clock: systemClock,
    frmHome: env.data.FRM_HOME,
    adapters,
    // Every executor the lifecycle loaded: a reviewer may be placed on a container.
    executors: new Map(
      [...placement.loaded()].map(([id, e]) => [id, e.executor]),
    ),
    path: process.env["PATH"] ?? "",
    secrets: secrets.value.spawn,
  });

  // The nightly encrypted backup and, after a good one, event retention (§13.2, §14).
  // The key comes from the same two stores as every spawn secret, in the same order, and only into
  // this job; when the environment supplies it, the job warns. Boot sweeps what a killed backup or
  // restore left.
  current.backups = wireBackups({
    db: started.value.db,
    clock: systemClock,
    log: log.child({ component: "backup" }),
    home: env.data.FRM_HOME,
    secrets: secrets.value.stores,
    ...(env.data.FRM_DB === undefined ? {} : { liveDb: env.data.FRM_DB }),
  });

  // The runner update check: a fixed unauthenticated GET of each adapter's own package
  // on npm, at boot and on `runners.update_check_hours`; it never upgrades anything.
  const updateCheckLog = log.child({ component: "update-check" });
  current.updateCheck = createUpdateCheckScheduler({
    clock: systemClock,
    loadHours: () => loadUpdateCheckHours(started.value.db),
    run: (signal) =>
      runUpdateCheckPass({
        db: started.value.db,
        clock: systemClock,
        adapters,
        log: updateCheckLog,
        signal,
      }),
    onError: (error) =>
      updateCheckLog.warn(
        { error },
        "the runner update check could not read its setting",
      ),
  });
  current.updateCheck.start();

  // Every handler is registered: what the last process left claimed is requeued or failed by its
  // handler's flag, then a command of an unknown type fails at once.
  const claiming = await started.value.startClaiming();
  if (!claiming.ok) {
    log.fatal({ error: claiming.error }, "cannot start claiming commands");
    await exit(1);
    return;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void exit(0));
  }
  // What a person at the terminal needs, in a few lines; the JSON log has it all at info.
  const ready = [
    `supervisor ${version} ready`,
    `  home      ${env.data.FRM_HOME}`,
    `  sessions  call ${mcpUrl}`,
    `  socket    ${socketPath(env.data.FRM_HOME)}`,
  ];
  if (output.format === "human") process.stdout.write(`${ready.join("\n")}\n`);
  else log.info({ mcpUrl, socket: socketPath(env.data.FRM_HOME) }, "ready");
}

await main();
