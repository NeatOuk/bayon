// What the pulse tests share (test-only): the orchestrator's rows, and a lifecycle on FakeExecutor
// with the in-process fixture, an ingest that sets spend.pulse_id, and a pulse scheduler over it.
// Seeding goes through @bayon/db/testing in each test file (only tests may import it), so the rows
// here are plain objects.
import { ok, type Clock, type FakeClock } from "@bayon/core";
import { pulseIdForSession, type Db } from "@bayon/db";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  FIXTURE_RUNNER_ID,
  fixtureProgram,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { pino } from "pino";
import { createIngest } from "../../ingest/ingest.js";
import type { Lifecycle, Log } from "../../lifecycle/index.js";
import {
  EXECUTOR_ID,
  PROFILE_ID,
  lifecycleRows,
  startLifecycle,
  type LogLine,
} from "../../lifecycle/testing/fixtures.js";
import type { Ingest } from "../../lifecycle/ports.js";
import { contextPackBuilder } from "../context-pack.js";
import { budgetGate } from "../gate.js";
import type { ContextPackBuilder, ProbeRunner, PulseGate } from "../ports.js";
import { createPulseScheduler, type PulseScheduler } from "../scheduler.js";

export const T0 = 1_700_000_000_000;
export const MIN = 60_000;
export const ORCH = "orch-1";
export const WAIT = { timeout: 15_000, interval: 5 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
/** One run that ends at once. */
export const QUICK: FixtureScriptInput = { runs: [{ events: [TURN] }] };
/** One run that goes silent until interrupted. */
export const HANG: FixtureScriptInput = {
  runs: [{ events: [TURN], then: "hang" }],
};

/**
 * A `budgets` row to seed (§4, §13.4). Spelled out here rather than imported from
 * @bayon/db/testing, which only test files may import.
 */
export interface BudgetSeed {
  readonly id: string;
  readonly scope: "fleet" | "agent";
  readonly scope_ref?: string | null;
  readonly period: "day" | "month";
  readonly cap_usd?: number | null;
  readonly cap_tokens?: number | null;
  readonly warn_pct?: number;
  readonly on_breach?: "warn" | "pause_admission";
  readonly updated_at: number;
}

export interface AgentOverrides {
  readonly pulse_mode?: "interval" | "on_idle" | "hybrid" | "manual";
  readonly pulse_interval_ms?: number;
  readonly pulse_debounce_ms?: number;
  readonly pulse_min_gap_ms?: number;
  readonly pulse_max_per_hour?: number;
  readonly created_at?: number;
  readonly workspace_id?: string | null;
}

/** lifecycleRows (a fixture runner, a builder agent) plus the orchestrator ORCH on one profile. */
export function pulseRows(
  o: {
    readonly script?: FixtureScriptInput;
    readonly agent?: AgentOverrides;
    readonly settings?: Readonly<Record<string, number>>;
    readonly slots?: number;
    /** §13.4's budgets, which the pulse gate reads since M4-c; seeded as given. */
    readonly budgets?: readonly BudgetSeed[];
  } = {},
) {
  const rows = lifecycleRows({
    healthArgv: ["ok"],
    script: o.script ?? QUICK,
    ...(o.settings === undefined ? {} : { settings: o.settings }),
    ...(o.slots === undefined ? {} : { slots: o.slots }),
  });
  return {
    ...rows,
    ...(o.budgets === undefined ? {} : { budgets: o.budgets }),
    agents: [
      ...rows.agents,
      {
        id: ORCH,
        name: ORCH,
        kind: "orchestrator" as const,
        runner_id: FIXTURE_RUNNER_ID,
        executor_id: EXECUTOR_ID,
        profile_id: PROFILE_ID,
        created_at: T0,
        ...o.agent,
      },
    ],
  };
}

/** Probes that always report one ok check (the seeded stale_sessions). */
export const OK_PROBES: ProbeRunner = {
  run: async () =>
    ok([
      {
        name: "stale_sessions",
        state: "ok",
        duration_ms: 1,
        result_json: "[]",
        result_path: null,
        error: null,
      },
    ]),
};

export interface RigOptions {
  readonly db: Db;
  readonly clock: FakeClock;
  readonly home: string;
  readonly slots?: number;
  /** Default true: the boot sweep, the catchups and the tick. */
  readonly start?: boolean;
  readonly pack?: ContextPackBuilder;
  readonly probes?: ProbeRunner;
  readonly gate?: PulseGate;
}

export interface Rig {
  readonly scheduler: PulseScheduler;
  readonly lifecycle: Lifecycle;
  readonly ingest: Ingest;
  readonly slots: SlotCounter;
  /** The scheduler's log lines. */
  readonly logs: LogLine[];
  /** The lifecycle's log lines. */
  readonly lifecycleLogs: LogLine[];
  /** Lets every queue and tracked piece of work settle, a few rounds deep. */
  settle(): Promise<void>;
  /** The scheduler, then the lifecycle, then the ingest; kills nothing. */
  stop(): Promise<void>;
}

/** A lifecycle and a pulse scheduler on `db`, as startSupervisor + wirePulse would make them. */
export async function startRig(o: RigOptions): Promise<Rig> {
  const slots = new SlotCounter(o.slots ?? 4);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
  });
  const ingest = createIngest({
    db: o.db,
    clock: o.clock,
    log: pino({ level: "silent" }),
    maxRows: 1,
    pulseOf: ({ sessionId }) => pulseIdForSession(o.db, sessionId),
  });
  const started = await startLifecycle({
    db: o.db,
    clock: o.clock,
    frmHome: o.home,
    executor,
    slots,
    adapter: createFixtureAdapter({
      command: [FIXTURE_PROGRAM],
      clock: o.clock,
    }),
    ingest,
  });
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
  const scheduler = createPulseScheduler({
    db: o.db,
    clock: o.clock as Clock,
    log,
    lifecycle: started.lifecycle,
    probes: o.probes ?? OK_PROBES,
    pack: o.pack ?? contextPackBuilder({ db: o.db, frmHome: o.home }),
    gate: o.gate ?? budgetGate({ db: o.db, log }),
    // pulse_report is still pending in the catalogue until an earlier change: the fixture mounts no tools.
    requireTools: [],
  });
  const offEnded = started.lifecycle.onSessionEnded((e) =>
    scheduler.sessionEnded(e),
  );
  const offPending = started.lifecycle.onHandoffPending((e) =>
    scheduler.fanOutCompletion(e.at, e.workspaceId),
  );
  const unsubscribe = () => {
    offEnded();
    offPending();
  };
  if (o.start !== false) await scheduler.start();
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await scheduler.settled();
      await started.lifecycle.settled();
    }
  };
  return {
    scheduler,
    lifecycle: started.lifecycle,
    ingest,
    slots,
    logs,
    lifecycleLogs: started.logs,
    settle,
    stop: async () => {
      unsubscribe();
      await scheduler.stop();
      await started.lifecycle.shutdown();
      await ingest.shutdown();
    },
  };
}
