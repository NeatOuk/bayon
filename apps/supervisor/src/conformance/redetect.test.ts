// Runner versions re-detected on each health pass ("Amendments — M4"): a changed version
// decertifies the pair, and admission's eligibility read with it; an unchanged one writes nothing;
// a decertified pair is never written again; a failing detection decertifies nothing.
import {
  CONFORMANCE_TEST_IDS,
  CONFORMANCE_TEST_NAMES,
  FakeClock,
  GATING_CAP,
  HEALTH_VERSION_CHECK,
  SUITE_VERSION,
  VERSION_TEST_ID,
  capsHash,
  certificationFlags,
  certify,
  err,
  judgeExecutorHealth,
  ok,
  type ConformanceResult,
  type HealthLimits,
  type Result,
} from "@bayon/core";
import {
  getExecutor,
  getLiveCertification,
  getRunner,
  getSession,
  listRunnerCertifications,
  listRunnerEligibility,
  type Db,
} from "@bayon/db";
import { storeCertification } from "@bayon/db/supervisor";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import {
  SlotCounter,
  type ExecutorHealthReport,
  type SessionPlace,
} from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import type { RunnerAdapter } from "@bayon/runners";
import { conformanceKit, kitHash } from "@bayon/runners/conformance";
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
} from "../lifecycle/testing/fixtures.js";

const T0 = 1_700_000_000_000;
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

type Answer = () => Result<{ version: string }>;

/** A certify()'d result for the fixture on the executor, test 1 pinning `pinned`. */
async function certifiedResult(
  adapter: RunnerAdapter,
  pinned: string,
  image_id: string | null = null,
): Promise<ConformanceResult> {
  const caps = adapter.registration().runner.caps;
  const tests = CONFORMANCE_TEST_IDS.map((id) => {
    const cap = GATING_CAP[id];
    const na = cap !== undefined && !caps[cap];
    return {
      id,
      name: CONFORMANCE_TEST_NAMES[id],
      status: na ? "na" : "pass",
      attempts: 1,
      duration_ms: 1,
      fallback: na ? "held" : null,
      checks:
        id === VERSION_TEST_ID
          ? [
              { name: "version_captured", ok: true, detail: FIXTURE_VERSION },
              { name: HEALTH_VERSION_CHECK, ok: true, detail: pinned },
            ]
          : [{ name: "held", ok: true, detail: null }],
    };
  });
  return unwrap(
    certify({
      schema: 1,
      suite_version: SUITE_VERSION,
      runner_id: FIXTURE_RUNNER_ID,
      runner_version: FIXTURE_VERSION,
      model: "fixture-model",
      executor: { id: EXECUTOR_ID, kind: "local", image_id },
      started_at: 1_000,
      finished_at: 2_000,
      kit_hash: await kitHash(
        unwrap(conformanceKit(FIXTURE_RUNNER_ID)),
        "fixture-model",
      ),
      ports: {
        ingest: "supervisor",
        watchdog: "supervisor",
        mcp: "supervisor",
        workspace: "supervisor",
      },
      caps,
      spend: { tokens_in: 1, tokens_out: 1, cost_usd: 0.01 },
      tests,
    }),
  );
}

/** The model the rig's profile runs (its tier is `standard`): the one certificate per pair. */
const FIXTURE_MODELS = [`${FIXTURE_RUNNER_ID}.standard`];

async function certifyPair(
  db: Db,
  r: ConformanceResult,
  models: readonly string[] = FIXTURE_MODELS,
): Promise<void> {
  for (const model_id of models) await certifyOn(db, r, model_id);
}

async function certifyOn(
  db: Db,
  r: ConformanceResult,
  model_id: string,
): Promise<void> {
  unwrap(
    await storeCertification(db, {
      runner_id: FIXTURE_RUNNER_ID,
      executor_id: EXECUTOR_ID,
      model_id,
      model: r.model ?? "none",
      runner_version: r.runner_version,
      suite_version: r.suite_version,
      kit_hash: r.kit_hash,
      caps_hash: await capsHash(r.caps),
      result_json: JSON.stringify(r),
      report_path: null,
      ...certificationFlags(r),
    }),
  );
}

/** An executor whose own check reports this clock skew, judged against the limits handed over. */
class SkewedExecutor extends FakeExecutor {
  readonly #skewMs: number;
  constructor(slots: SlotCounter, skewMs: number) {
    super({
      id: EXECUTOR_ID,
      slots,
      programs: { [FIXTURE_PROGRAM]: fixtureProgram },
    });
    this.#skewMs = skewMs;
  }
  override async health(limits: HealthLimits): Promise<ExecutorHealthReport> {
    return judgeExecutorHealth({
      checkedAt: 1,
      disk: [],
      clockSkewMs: this.#skewMs,
      limits,
    });
  }
}

/** A container-like executor: it places sessions, so a runner's health would need one of its own.
 * What it runs from has an identity instead, which is what a pass there re-reads. */
class PlacingExecutor extends SkewedExecutor {
  /** Mutable so a test can rebuild the image between passes; null = it will not say. */
  image: string | null = null;
  placeSession(sessionId: string): SessionPlace {
    const root = `/frm/s/${sessionId}`;
    return { root, home: `${root}/.frm/home`, tmp: `${root}/.frm/tmp` };
  }
  imageIdentity(): Promise<string | null> {
    return Promise.resolve(this.image);
  }
}

/** The fixture certified on the executor at version "1"; `answer` is what its health says now. */
async function setup(o: {
  answer: () => Answer;
  skewMs?: number;
  places?: boolean;
  /** What the result pins as the image it was certified inside, and what the executor says now. */
  image?: { readonly pinned: string | null; readonly now: string | null };
  /** The models the pair is certified on; default the rig profile's alone. */
  models?: readonly string[];
}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedRows(t.db, lifecycleRows()));
  const base = createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock });
  await certifyPair(
    t.db,
    await certifiedResult(base, FIXTURE_VERSION, o.image?.pinned ?? null),
    o.models,
  );
  let asked = 0;
  const adapter: RunnerAdapter = {
    ...base,
    health: async () => {
      asked += 1;
      return o.answer()();
    },
  };
  const home = tempHome();
  const slots = new SlotCounter(2);
  const placing = new PlacingExecutor(slots, o.skewMs ?? 0);
  placing.image = o.image?.now ?? null;
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor:
      o.places === true ? placing : new SkewedExecutor(slots, o.skewMs ?? 0),
    slots,
    adapter,
    // Opt out of the rig's certification: it pins no version, and would replace the one above.
    certified: false,
  });
  cleanups.push(() => {
    started.lifecycle.shutdown();
    t.cleanup();
    home.cleanup();
  });
  return {
    db: t.db,
    clock,
    logs: started.logs,
    asked: () => asked,
    /** Rebuilds the image behind the executor's tag, as `frm executor image` would. */
    rebuild: (id: string | null) => {
      placing.image = id;
    },
    /** One health pass, as `executor.health` (and the reconciler) runs it. */
    pass: async () =>
      unwrap(
        await started.lifecycle.handlers.health.handle(
          { executor_id: EXECUTOR_ID },
          CMD,
        ),
      ),
    /** A spawn as `session.spawn` delivers it: admission's early gates decide first. */
    spawn: (id: string) =>
      started.lifecycle.handlers.spawn.handle(spawnPayload(id), CMD),
    pair: async () => unwrap(await listRunnerCertifications(t.db))[0],
    detail: async () =>
      JSON.parse(
        unwrap(await getExecutor(t.db, EXECUTOR_ID)).health_detail ?? "null",
      ) as { readonly runners?: unknown },
    warnings: (text: string) =>
      started.logs.filter((l) => l.level === "warn" && l.msg.includes(text)),
  };
}

const says =
  (version: string): Answer =>
  () =>
    ok({ version });

test("an unchanged version writes nothing: the pair and its roll-up stay exactly as they were", async () => {
  const h = await setup({ answer: () => says(FIXTURE_VERSION) });
  const before = await h.pair();
  expect(before).toMatchObject({ decertified_at: null, passed_at: 2_000 });
  await h.pass();
  await h.pass();
  expect(h.asked()).toBe(3); // boot's pass, then two
  expect(await h.pair()).toEqual(before);
  expect(unwrap(await getRunner(h.db, FIXTURE_RUNNER_ID))).toMatchObject({
    conformance_passed_at: 2_000,
  });
  expect(h.warnings("uncertified")).toEqual([]);
  expect((await h.detail()).runners).toEqual({
    [FIXTURE_RUNNER_ID]: { version: FIXTURE_VERSION, error: null },
  });
});

test("a version bump on the next pass decertifies the pair, and admission then refuses it `uncertified`", async () => {
  let version = FIXTURE_VERSION;
  const h = await setup({ answer: () => says(version) });
  version = "2";
  await h.pass();
  const reason = `health_version ${FIXTURE_VERSION} → 2 on ${EXECUTOR_ID}`;
  expect(await h.pair()).toMatchObject({
    decertified_at: T0,
    decertified_reason: reason,
    passed_at: null,
    gate_eligible: 0,
  });
  expect(unwrap(await getRunner(h.db, FIXTURE_RUNNER_ID))).toMatchObject({
    conformance_passed_at: null,
    gate_eligible: 0,
  });
  // Admission's `uncertified` gate and reviewer selection share LIVE_PAIR.
  expect(
    unwrap(
      await getLiveCertification(
        h.db,
        FIXTURE_RUNNER_ID,
        EXECUTOR_ID,
        `${FIXTURE_RUNNER_ID}.standard`,
        false,
      ),
    ),
  ).toBeNull();
  expect(
    unwrap(await listRunnerEligibility(h.db, EXECUTOR_ID, FIXTURE_MODELS)).find(
      (r) => r.id === FIXTURE_RUNNER_ID,
    ),
  ).toMatchObject({ conformance_passed_at: null, gate_eligible: 0 });
  expect(await h.spawn("S")).toMatchObject({
    ok: false,
    error: { class: "admission_refused", cause: { gate: "uncertified" } },
  });
  expect((await getSession(h.db, "S")).ok).toBe(false);
  expect(h.warnings("uncertified").map((l) => l.msg)).toEqual([
    `runner ${FIXTURE_RUNNER_ID} is uncertified on ${EXECUTOR_ID}: ${reason}`,
  ]);
  expect((await h.detail()).runners).toEqual({
    [FIXTURE_RUNNER_ID]: { version: "2", error: null },
  });
});

test("no spam: a decertified pair is never written again, nor its version asked", async () => {
  let version = FIXTURE_VERSION;
  const h = await setup({ answer: () => says(version) });
  version = "2";
  await h.pass();
  const decertified = await h.pair();
  const asked = h.asked();
  await h.clock.advance(60_000);
  await h.pass();
  version = "3";
  await h.pass();
  expect(await h.pair()).toEqual(decertified);
  expect(h.asked()).toBe(asked);
  expect(h.warnings("uncertified")).toHaveLength(1);
  // Nothing is pinned there any more, so the runner drops out of the readings.
  expect((await h.detail()).runners).toEqual({});
});

test("a failing detection decertifies nothing, is recorded, and is logged once", async () => {
  let answer: Answer = says(FIXTURE_VERSION);
  const h = await setup({ answer: () => answer });
  answer = () =>
    err({
      class: "runner_error",
      message: "runner --version failed",
      retryable: false,
    });
  await h.pass();
  await h.pass();
  expect(await h.pair()).toMatchObject({ decertified_at: null });
  expect((await h.detail()).runners).toEqual({
    [FIXTURE_RUNNER_ID]: { version: null, error: "runner --version failed" },
  });
  expect(h.warnings("cannot re-detect")).toHaveLength(1);
});

test("an unhealthy executor's runners are not asked, and nothing is decertified", async () => {
  const h = await setup({ answer: () => says("2"), skewMs: 60_000 });
  await h.pass();
  expect(h.asked()).toBe(0);
  expect(await h.pair()).toMatchObject({ decertified_at: null });
  expect((await h.detail()).runners).toBeUndefined();
});

test("an executor that places sessions is not asked: test 1 read its version inside a session", async () => {
  const h = await setup({ answer: () => says("2"), places: true });
  await h.pass();
  expect(h.asked()).toBe(0);
  expect(await h.pair()).toMatchObject({ decertified_at: null });
  expect((await h.detail()).runners).toEqual({});
});

const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;

test("a placing executor on the image it was certified inside keeps its pair", async () => {
  const h = await setup({
    answer: () => says("2"),
    places: true,
    image: { pinned: IMAGE_A, now: IMAGE_A },
  });
  const before = await h.pair();
  await h.pass();
  await h.pass();
  expect(h.asked()).toBe(0);
  expect(await h.pair()).toEqual(before);
  expect(h.warnings("uncertified")).toEqual([]);
});

test("a rebuilt image decertifies the pair, and admission then refuses it `uncertified`", async () => {
  const h = await setup({
    answer: () => says("2"),
    places: true,
    image: { pinned: IMAGE_A, now: IMAGE_A },
  });
  h.rebuild(IMAGE_B);
  await h.pass();
  const reason = `image_id ${IMAGE_A} → ${IMAGE_B} on ${EXECUTOR_ID}`;
  expect(await h.pair()).toMatchObject({
    decertified_at: T0,
    decertified_reason: reason,
    passed_at: null,
    gate_eligible: 0,
  });
  expect(
    unwrap(
      await getLiveCertification(
        h.db,
        FIXTURE_RUNNER_ID,
        EXECUTOR_ID,
        `${FIXTURE_RUNNER_ID}.standard`,
        false,
      ),
    ),
  ).toBeNull();
  expect(await h.spawn("S")).toMatchObject({
    ok: false,
    error: { class: "admission_refused", cause: { gate: "uncertified" } },
  });
  expect(h.warnings("uncertified").map((l) => l.msg)).toEqual([
    `runner ${FIXTURE_RUNNER_ID} is uncertified on ${EXECUTOR_ID}: ${reason}`,
  ]);
});

test("an image the executor will not name decertifies nothing", async () => {
  const h = await setup({
    answer: () => says("2"),
    places: true,
    image: { pinned: IMAGE_A, now: null },
  });
  await h.pass();
  expect(await h.pair()).toMatchObject({ decertified_at: null });
  expect(h.warnings("uncertified")).toEqual([]);
});

test("certified on two models: one health call per pass, and a version bump decertifies both", async () => {
  let version = FIXTURE_VERSION;
  const models = [
    `${FIXTURE_RUNNER_ID}.standard`,
    `${FIXTURE_RUNNER_ID}.cheap`,
  ];
  const h = await setup({ answer: () => says(version), models });
  await h.pass();
  expect(h.asked()).toBe(2); // boot's pass, then one: never once per model
  version = "2";
  await h.pass();
  expect(h.asked()).toBe(3);
  const rows = unwrap(await listRunnerCertifications(h.db));
  expect(rows.map((r) => [r.model_id, r.decertified_at])).toEqual(
    models.toSorted().map((m) => [m, T0]),
  );
});
