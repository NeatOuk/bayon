// Test-only rig for the admission tests: rows as plain objects, and a
// lifecycle on the fixture runner and FakeExecutor on 012's real defaults. Only tests import the
// db's test helpers (no-sql.test.ts), so each test file seeds admissionRows and edits rows itself.
// The drain runs off the session queues, so waits settle and poll.
import { TEMPLATES, type FakeClock } from "@bayon/core";
import { getSession, type Db, type SessionRow } from "@bayon/db";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import type { RunnerAdapter } from "@bayon/runners";
import { expect, vi } from "vitest";
import type { AdmissionHooks } from "../admission.js";
import type { SessionSpawnPayload, StopMode } from "../payloads.js";
import type { RunRequest } from "../prompt.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
  type RowOptions,
} from "./fixtures.js";

export const T0 = 1_700_000_000_000;
export const WAIT = { timeout: 10_000, interval: 5 };
/** The second executor, when a test asks for one: same kind, own slots. */
export const SECOND = "local-2";
/** 012's admission.recheck_ms. */
const RECHECK_MS = 5_000;
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const QUICK: FixtureScriptInput = { runs: [{ events: [TURN] }] };

/** An operator's run n on a live session (Lifecycle.startRun), kind `run` unless given. */
export const operatorRun = (seq: number, o: Partial<RunRequest> = {}) => ({
  seq,
  trigger: "operator" as const,
  template: TEMPLATES.operator,
  inputs: { task: "go" },
  ...o,
});

export interface WorldOptions {
  readonly rows?: RowOptions;
  /** executors.slots, for every executor's row. Default 4. */
  readonly slots?: number;
  /** The counters' constructed capacity when it should differ from the row's. */
  readonly counter?: number;
  readonly certified?: boolean;
  readonly jobRunners?: ReadonlySet<string>;
  readonly hooks?: AdmissionHooks;
  /** A second executor, SECOND, with its own counter. */
  readonly second?: boolean;
  /**
   * The runner declares §5.1 `concurrentSessions` absent: its credential serves one live session,
   * so admission must queue the next spawn of it rather than fail it.
   */
  readonly singleSession?: boolean;
  /** Wraps the rig's adapter, e.g. to watch the SpawnSpec it is given. */
  readonly wrap?: (adapter: RunnerAdapter) => RunnerAdapter;
}

/** `inner` with `concurrentSessions` declared absent, in its caps and in the row it registers. */
function singleSessionAdapter(inner: RunnerAdapter): RunnerAdapter {
  const caps = { ...inner.caps(), concurrentSessions: false };
  const registration = inner.registration();
  return {
    ...inner,
    caps: () => caps,
    registration: () => ({
      ...registration,
      runner: { ...registration.runner, caps },
    }),
  };
}

/** The operator rows a world needs, for the test file to seed. */
export function admissionRows(o: WorldOptions = {}) {
  const rows = lifecycleRows({
    healthArgv: ["ok"],
    script: QUICK,
    slots: o.slots ?? 4,
    ...o.rows,
  });
  return {
    ...rows,
    executors: rows.executors.flatMap((e) =>
      o.second === true ? [e, { ...e, id: SECOND }] : [e],
    ),
  };
}

/** A booted lifecycle over the seeded `db`, and the steps the admission tests take with it. */
export async function startAdmission(
  db: Db,
  clock: FakeClock,
  o: WorldOptions = {},
) {
  const home = tempHome();
  const programs = {
    [FIXTURE_PROGRAM]: fixtureProgram,
    ok: () => 0,
    fail: () => 1,
  };
  const capacity = o.counter ?? o.slots ?? 4;
  const slots = new SlotCounter(capacity);
  const slots2 = new SlotCounter(capacity);
  const base = createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock });
  const single = o.singleSession === true ? singleSessionAdapter(base) : base;
  const adapter = o.wrap === undefined ? single : o.wrap(single);
  const started = await startLifecycle({
    db,
    clock,
    frmHome: home.path,
    executor: new FakeExecutor({ id: EXECUTOR_ID, slots, programs }),
    slots,
    ...(o.second === true
      ? {
          others: [
            {
              executor: new FakeExecutor({
                id: SECOND,
                slots: slots2,
                programs,
              }),
              slots: slots2,
            },
          ],
        }
      : {}),
    adapter,
    ...(o.certified === undefined ? {} : { certified: o.certified }),
    ...(o.jobRunners === undefined ? {} : { jobRunners: o.jobRunners }),
    ...(o.hooks === undefined ? {} : { admissionHooks: o.hooks }),
  });
  const { lifecycle } = started;
  const ended: string[] = [];
  lifecycle.onSessionEnded((e) => ended.push(e.sessionId));
  const session = async (id: string): Promise<SessionRow> => {
    const s = await getSession(db, id);
    if (!s.ok) throw new Error(`${s.error.class}: ${s.error.message}`);
    return s.value;
  };
  return {
    db,
    clock,
    slots,
    slots2,
    adapter,
    lifecycle,
    logs: started.logs,
    ended,
    session,
    shutdown: async () => {
      await lifecycle.shutdown();
      home.cleanup();
    },
    spawn: (id: string, extra: Partial<SessionSpawnPayload> = {}) =>
      lifecycle.handlers.spawn.handle(spawnPayload(id, extra), CMD),
    stop: (id: string, mode: StopMode) => lifecycle.stop(id, mode),
    /** One admission.recheck_ms on the clock, then everything it started settles. */
    recheck: async () => {
      await clock.advance(RECHECK_MS);
      await lifecycle.settled();
    },
    /** Waits until the session's row matches. */
    until: (id: string, match: Partial<SessionRow>) =>
      vi.waitFor(async () => {
        await lifecycle.settled();
        expect(await session(id)).toMatchObject(match);
      }, WAIT),
  };
}
