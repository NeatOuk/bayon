// Executor health (§6.1, §9.6 step 7): each executor's own check, judged against
// the limits read from settings on every check. Its verdict decides admission, its detail — the
// ssh round trip included — is recorded in executors.health_detail, and an unhealthy executor
// shows in v_needs_attention.
import {
  canonicalJson,
  FakeClock,
  judgeExecutorHealth,
  type HealthLimits,
} from "@bayon/core";
import { getExecutor, getSession, listNeedsAttention } from "@bayon/db";
import { seedRows, tempDb, unwrap, updateRowForTest } from "@bayon/db/testing";
import { SlotCounter, type ExecutorHealthReport } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  FIXTURE_RUNNER_ID,
  FIXTURE_VERSION,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { afterAll, expect, test } from "vitest";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

type Check = (limits: HealthLimits) => Promise<ExecutorHealthReport>;

/** The fake executor, plus a health check that reports whatever `report` says. */
class ReportingExecutor extends FakeExecutor {
  readonly #report: Check;
  /** The limits each check was handed. */
  readonly seen: HealthLimits[] = [];
  /** Each config a pass handed it, newest last. */
  readonly adopted: unknown[] = [];

  reloadConfig(config: unknown): string | null {
    this.adopted.push(config);
    return null;
  }

  constructor(slots: SlotCounter, report: Check) {
    super({
      id: EXECUTOR_ID,
      slots,
      programs: { [FIXTURE_PROGRAM]: fixtureProgram },
    });
    this.#report = report;
  }

  override health(limits: HealthLimits): Promise<ExecutorHealthReport> {
    this.seen.push(limits);
    return this.#report(limits);
  }
}

async function setup(
  report: Check,
  settings: Readonly<Record<string, number>> = {},
) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedRows(t.db, lifecycleRows({ settings })));
  const home = tempHome();
  const slots = new SlotCounter(2);
  const executor = new ReportingExecutor(slots, report);
  // The rig certifies the fixture on the executor (require_certified=1), pinning no version.
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock }),
  });
  cleanups.push(() => {
    started.lifecycle.shutdown();
    t.cleanup();
    home.cleanup();
  });
  const spawn = async (id: string) => {
    unwrap(
      await started.lifecycle.handlers.spawn.handle(spawnPayload(id), CMD),
    );
    await started.lifecycle.settled();
    return unwrap(await getSession(t.db, id));
  };
  const row = async () => unwrap(await getExecutor(t.db, EXECUTOR_ID));
  const attention = async () =>
    unwrap(await listNeedsAttention(t.db)).filter(
      (a) => a.why === "executor_unhealthy",
    );
  return {
    db: t.db,
    spawn,
    row,
    attention,
    slots,
    seen: executor.seen,
    adopted: executor.adopted,
    logs: started.logs,
    /** One health pass, as the reconciler and `frm executor health` run it. */
    pass: async () =>
      unwrap(
        await started.lifecycle.handlers.health.handle(
          { executor_id: EXECUTOR_ID },
          CMD,
        ),
      ),
  };
}

const UNIFORM = {
  checked_at: 1,
  free_pct: 40,
  min_free_pct: 10,
  disk: [{ path: "/w", free_pct: 40, error: null }],
  clock_skew_ms: 12,
  clock_skew_max_ms: 5_000,
  warnings: [],
};
const TUNNEL_DOWN: ExecutorHealthReport = {
  healthy: false,
  detail: {
    ...UNIFORM,
    rtt_ms: 312,
    tunnel: "down",
    mcp: "error:ECONNREFUSED",
    failures: ["tunnel: the /mcp reverse tunnel is down"],
  },
};
const HEALTHY: ExecutorHealthReport = {
  healthy: true,
  detail: { ...UNIFORM, rtt_ms: 298, tunnel: "up", mcp: "401", failures: [] },
};

/** A check measuring one disk and a clock, judged by core against the limits it is handed. */
const measuring =
  (freePct: number, skewMs: number): Check =>
  async (limits) =>
    judgeExecutorHealth({
      checkedAt: 1,
      disk: [{ path: "/w", free_pct: freePct, error: null }],
      clockSkewMs: skewMs,
      limits,
    });

test("its tunnel down, the executor's own check queues the spawn `unhealthy`; the detail says why", async () => {
  const h = await setup(async () => TUNNEL_DOWN);
  expect(await h.spawn("U")).toMatchObject({
    state: "pending",
    queued_reason: "unhealthy",
  });
  expect(await h.row()).toMatchObject({
    health: "unhealthy",
    health_detail: canonicalJson(TUNNEL_DOWN.detail),
  });
  expect(h.slots.capacity().used).toBe(0);
});

test("a passing check admits the spawn and records its detail, the ssh round trip and runner readings included", async () => {
  const h = await setup(async () => HEALTHY);
  expect((await h.spawn("H")).error_class).toBeNull();
  expect(await h.row()).toMatchObject({
    health: "healthy",
    // The fixture is certified here, so its version was re-detected on the executor.
    health_detail: canonicalJson({
      ...HEALTHY.detail,
      runners: {
        [FIXTURE_RUNNER_ID]: { version: FIXTURE_VERSION, error: null },
      },
    }),
  });
});

test("a check that throws is a failed check, recorded without detail", async () => {
  const h = await setup(async () => {
    throw new Error("the health check's own bug");
  });
  expect(await h.spawn("T")).toMatchObject({
    state: "pending",
    queued_reason: "unhealthy",
  });
  expect(await h.row()).toMatchObject({
    health: "unhealthy",
    health_detail: null,
  });
});

test("the limits come from settings: executor.clock_skew_max_ms and admission.disk_min_free_pct", async () => {
  const seeded = await setup(async () => HEALTHY);
  // 012 seeds both rows with the M4 contract's values.
  expect(seeded.seen[0]).toEqual({ clockSkewMaxMs: 5_000, minFreePct: 10 });
  const set = await setup(async () => HEALTHY, {
    "executor.clock_skew_max_ms": 1_234,
    "admission.disk_min_free_pct": 42,
  });
  expect(set.seen[0]).toEqual({ clockSkewMaxMs: 1_234, minFreePct: 42 });
});

test("disk below the floor: unhealthy, the detail says where, and the executor needs attention", async () => {
  const h = await setup(measuring(8, 0));
  const row = await h.row();
  expect(row.health).toBe("unhealthy");
  expect(JSON.parse(row.health_detail ?? "null")).toMatchObject({
    free_pct: 8,
    min_free_pct: 10,
    failures: ["disk: /w: 8 % free, under min_free_pct 10"],
  });
  expect(await h.attention()).toEqual([
    { why: "executor_unhealthy", ref: EXECUTOR_ID, ticket_id: null },
  ]);
  // The same disk under a lower floor from settings passes, and nothing needs attention.
  const lower = await setup(measuring(8, 0), {
    "admission.disk_min_free_pct": 5,
  });
  expect((await lower.row()).health).toBe("healthy");
  expect(await lower.attention()).toEqual([]);
});

test("clock skew above the max: unhealthy; under a raised max it passes", async () => {
  const h = await setup(measuring(40, 6_000));
  expect(await h.row()).toMatchObject({ health: "unhealthy" });
  expect(JSON.parse((await h.row()).health_detail ?? "null").failures).toEqual([
    "clock: skewed 6000 ms (max 5000)",
  ]);
  const raised = await setup(measuring(40, 6_000), {
    "executor.clock_skew_max_ms": 7_000,
  });
  expect((await raised.row()).health).toBe("healthy");
});

test("a setting the check cannot use fails the check and names the setting", async () => {
  const h = await setup(async () => HEALTHY, {
    "admission.disk_min_free_pct": 250,
  });
  expect(h.seen).toEqual([]);
  expect(await h.row()).toMatchObject({
    health: "unhealthy",
    health_detail: null,
  });
  expect(
    h.logs.some(
      (l) =>
        l.level === "warn" && l.msg.includes("admission.disk_min_free_pct"),
    ),
  ).toBe(true);
});

test("each pass hands the executor its row as the DB now holds it", async () => {
  const h = await setup(measuring(40, 12));
  expect(h.adopted).toEqual([{}]); // boot's pass, on the seeded config
  // `frm executor image` writing a new tag while the supervisor runs. Before this, the executor
  // kept its boot-time image and tore the freshly built gateway down as foreign.
  unwrap(
    await updateRowForTest(h.db, "executors", EXECUTOR_ID, {
      config_json: JSON.stringify({ image: "frm/ctr:rebuilt" }),
    }),
  );
  await h.pass();
  expect(h.adopted.at(-1)).toEqual({ image: "frm/ctr:rebuilt" });
});

test("a row whose config_json is not JSON is handed over as nothing, not thrown on", async () => {
  const h = await setup(measuring(40, 12));
  unwrap(
    await updateRowForTest(h.db, "executors", EXECUTOR_ID, {
      config_json: "{not json",
    }),
  );
  // Unhealthy for its own reason — the healthArgv check refuses a config_json it cannot read —
  // but the pass runs to that verdict rather than throwing on the way.
  expect(await h.pass()).toMatchObject({ health: "unhealthy" });
  expect(h.adopted).toEqual([{}, undefined]);
});
