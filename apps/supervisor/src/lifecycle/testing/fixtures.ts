// What the lifecycle tests share: operator rows for the fixture runner, a temp FRM_HOME and the
// wiring. Test-only. Seeding goes through @bayon/db/testing in each test file (only tests may
// import it), so the rows here are plain objects.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Clock } from "@bayon/core";
import type { Db } from "@bayon/db";
import { pino } from "pino";
import { createIngest } from "../../ingest/ingest.js";
import type { Executor, SlotCounter } from "@bayon/executors";
import { CATALOGUE_TOOLS } from "@bayon/proto";
import type { RunnerAdapter } from "@bayon/runners";
import {
  FIXTURE_CAPS,
  FIXTURE_RUNNER_ID,
  FIXTURE_VERSION,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import type { Log } from "../context.js";
import {
  createLifecycle,
  type Lifecycle,
  type LifecycleDeps,
} from "../index.js";
import type { SessionSpawnPayload } from "../payloads.js";
import type { Ingest } from "../ports.js";
import { envSecrets } from "../secrets.js";
import { certifyPair } from "./certify.js";

export const AGENT_ID = "agent-1";
export const PROFILE_ID = "profile-1";
export const EXECUTOR_ID = "local";
const HASH = "0".repeat(64);

export interface RowOptions {
  readonly script?: FixtureScriptInput;
  readonly slots?: number;
  readonly healthArgv?: readonly string[];
  /** `settings` rows, e.g. `{ "lifecycle.adopt_max": 2 }`. */
  readonly settings?: Readonly<Record<string, number>>;
  readonly caps?: Readonly<Record<string, boolean>>;
  readonly workspaceId?: string;
  /**
   * The profile's MCP tool allowlist (wire names). Default: the whole catalogue, as `frm config
   * apply` fills it, so the role's row decides; `[]` is admission's `no_tools` for a work role.
   */
  readonly toolAllowlist?: readonly string[];
  /**
   * The agent's max_concurrency. Default: the column's (1), admission's real default (design
   *; only a test that really spawns in parallel for the agent raises it, and says why.
   */
  readonly maxConcurrency?: number;
  /**
   * The runner row's defaults_json. Default `{}`: no sessionBaselineTokens, so admission's
   * context_baseline checks nothing.
   */
  readonly runnerDefaults?: Readonly<Record<string, unknown>>;
  /** The profile's secret_refs_json: names resolveCredentials must find in the secret store. */
  readonly secretRefs?: readonly string[];
}

/** A fixture runner, its models, one executor, a profile and an agent: what a spawn resolves. */
export function lifecycleRows(o: RowOptions = {}) {
  return {
    runners: [
      {
        id: FIXTURE_RUNNER_ID,
        kind: "script",
        adapter: FIXTURE_RUNNER_ID,
        version_detected: FIXTURE_VERSION,
        caps_json: JSON.stringify({ ...FIXTURE_CAPS, ...o.caps }),
        defaults_json: JSON.stringify(o.runnerDefaults ?? {}),
      },
    ],
    models: (["complex", "standard", "cheap"] as const).map((tier) => ({
      id: `${FIXTURE_RUNNER_ID}.${tier}`,
      runner_id: FIXTURE_RUNNER_ID,
      tier,
      model: "fixture-model",
      // Priced (free): admission refuses an unpriced model.
      price_in_per_mtok: 0,
      price_out_per_mtok: 0,
      price_cache_read_per_mtok: 0,
      price_cache_write_per_mtok: 0,
    })),
    executors: [
      {
        id: EXECUTOR_ID,
        kind: "local" as const,
        config_json: JSON.stringify(
          o.healthArgv === undefined ? {} : { healthArgv: o.healthArgv },
        ),
        slots: o.slots ?? 4,
      },
    ],
    profiles: [
      {
        id: PROFILE_ID,
        name: PROFILE_ID,
        runner_id: FIXTURE_RUNNER_ID,
        model_tier: "standard",
        sandbox_json: JSON.stringify(
          o.script === undefined ? {} : { script: o.script },
        ),
        secret_refs_json: JSON.stringify(o.secretRefs ?? []),
        tool_allowlist_json: JSON.stringify(o.toolAllowlist ?? CATALOGUE_TOOLS),
        version: 1,
        hash: HASH,
        created_at: 0,
      },
    ],
    agents: [
      {
        id: AGENT_ID,
        name: AGENT_ID,
        kind: "builder" as const,
        runner_id: FIXTURE_RUNNER_ID,
        executor_id: EXECUTOR_ID,
        profile_id: PROFILE_ID,
        workspace_id: o.workspaceId ?? null,
        ...(o.maxConcurrency === undefined
          ? {}
          : { max_concurrency: o.maxConcurrency }),
        created_at: 0,
      },
    ],
    settings: Object.entries(o.settings ?? {}).map(([key, value]) => ({
      key,
      value_json: JSON.stringify(value),
      updated_at: 0,
    })),
  };
}

export const spawnPayload = (
  sessionId: string,
  extra: Partial<SessionSpawnPayload> = {},
): SessionSpawnPayload => ({
  session_id: sessionId,
  agent_id: AGENT_ID,
  role: "builder",
  run_class: "build",
  ...extra,
});

/** The claimer's side of a handler call. */
export const CMD = { id: "cmd-1", attempts: 1 } as const;

/** A fresh FRM_HOME under /tmp (short paths, §10 of the design). */
export function tempHome(prefix = "frm-lc-"): {
  readonly path: string;
  cleanup(): void;
} {
  const path = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export interface LogLine {
  readonly level: "info" | "warn" | "error";
  readonly msg: string;
  readonly obj: object;
}

export interface Started {
  readonly lifecycle: Lifecycle;
  readonly ingest: Ingest;
  readonly logs: LogLine[];
}

/** A lifecycle over one executor and one adapter, booted unless `boot: false`. */
export async function startLifecycle(o: {
  readonly db: Db;
  readonly clock: Clock;
  readonly frmHome: string;
  readonly executor: Executor;
  readonly slots: SlotCounter;
  /** Executors from their rows, loaded at boot. */
  readonly loadExecutors?: LifecycleDeps["loadExecutors"];
  /** More executors beside `executor`, e.g. a container over the loopback. */
  readonly others?: readonly {
    readonly executor: Executor;
    readonly slots: SlotCounter;
  }[];
  readonly adapter: RunnerAdapter;
  readonly ingest?: Ingest;
  readonly secrets?: Readonly<Record<string, string>>;
  /** What a repo URL's host resolves to; default: nothing, and no network. */
  readonly resolveHost?: LifecycleDeps["resolveHost"];
  readonly boot?: boolean;
  /** PATH for runner and git processes. Default: the supervisor's own. */
  readonly path?: string;
  readonly mcpUrl?: string;
  /** Default: always reachable, so no test depends on an API being up. */
  readonly mcpReachable?: (url: string) => Promise<boolean>;
  /** The claimer's requeue, for the periodic pass's command step. */
  readonly commands?: LifecycleDeps["commands"];
  /** FRM_HOME_TAG, given as main.ts gives it: the boot then self-checks the orphan scan. */
  readonly homeTag?: string;
  /**
   * Rigs run on 012's real defaults, require_certified=1 included, so the adapter is certified on
   * every executor first, through certify(). `false`: the pair stays bare.
   */
  readonly certified?: boolean;
  /** The daemon's own job runners. */
  readonly jobRunners?: ReadonlySet<string>;
  /** Seams inside the admission drain: a test's step inside the claim-to-CAS window. */
  readonly admissionHooks?: LifecycleDeps["admissionHooks"];
  /** The relay server (/135, §12.5): given, attach registers a session's pty on it.
   * Absent (most tests) skips pty streaming entirely — attach/detach still work. */
  readonly relay?: LifecycleDeps["relay"];
}): Promise<Started> {
  if (o.certified !== false) {
    for (const e of [o.executor, ...(o.others ?? []).map((x) => x.executor)]) {
      await certifyPair(o.db, {
        runnerId: o.adapter.id,
        runnerVersion: o.adapter.registration().runner.versionDetected ?? "rig",
        caps: o.adapter.caps(),
        executorId: e.id,
        executorKind: e.kind === "container" ? "container" : "local",
        at: o.clock.now(),
      });
    }
  }
  const logs: LogLine[] = [];
  const line =
    (level: LogLine["level"]) =>
    (obj: object, msg: string): void => {
      logs.push({ level, msg, obj });
    };
  const log: Log = {
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  };
  const owned = o.ingest === undefined;
  // Every record commits at once: a FakeClock never fires the 50 ms batch timer (§9.4 is
  // ingest's own test).
  const ingest =
    o.ingest ??
    createIngest({
      db: o.db,
      clock: o.clock,
      log: pino({ level: "silent" }),
      maxRows: 1,
    });
  const lifecycle = createLifecycle({
    db: o.db,
    clock: o.clock,
    log,
    frmHome: o.frmHome,
    executors: new Map([
      [o.executor.id, { executor: o.executor, slots: o.slots }],
      ...(o.others ?? []).map((e) => [e.executor.id, e] as const),
    ]),
    adapters: new Map([[o.adapter.id, o.adapter]]),
    ingest,
    secrets: envSecrets(o.secrets ?? {}),
    // No test resolves a name over the network: the literal host alone is judged.
    resolveHost: o.resolveHost ?? (() => Promise.resolve([])),
    ...(o.path === undefined ? {} : { path: o.path }),
    ...(o.mcpUrl === undefined ? {} : { mcpUrl: o.mcpUrl }),
    ...(o.loadExecutors === undefined
      ? {}
      : { loadExecutors: o.loadExecutors }),
    mcpReachable: o.mcpReachable ?? (async () => true),
    ...(o.commands === undefined ? {} : { commands: o.commands }),
    ...(o.homeTag === undefined ? {} : { homeTag: o.homeTag }),
    ...(o.jobRunners === undefined ? {} : { jobRunners: o.jobRunners }),
    ...(o.admissionHooks === undefined
      ? {}
      : { admissionHooks: o.admissionHooks }),
    ...(o.relay === undefined ? {} : { relay: o.relay }),
  });
  if (o.boot !== false) {
    const booted = await lifecycle.boot();
    if (!booted.ok) throw new Error(booted.error.message);
  }
  // Shutting the lifecycle down also stops the ingest the harness made, as the process does.
  const shutdown = async () => {
    await lifecycle.shutdown();
    if (owned) await ingest.shutdown();
  };
  return { lifecycle: { ...lifecycle, shutdown }, ingest, logs };
}
