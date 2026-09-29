import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  modelRow,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import {
  closeConformanceProbe,
  decertifyPairs,
  findLiveConformanceProbe,
  getLiveCertification,
  listRunnerCertifications,
  listRunnerEligibility,
  openConformanceProbe,
  storeCertification,
  type NewCertification,
} from "./certifications.js";
import { getRunner } from "./config.js";
import { seedConformanceScratch } from "./conformance-scratch.js";
import { upsertExecutor, upsertRegistration } from "./registration.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function seeded() {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 8));
  unwrap(
    await seedRows(t.db, {
      models: [modelRow(runnerId, "cheap"), modelRow(runnerId, "complex")],
    }),
  );
  unwrap(
    await upsertExecutor(t.db, {
      id: "ctr",
      kind: "container",
      config_json: "{}",
    }),
  );
  return t.db;
}

const { runnerId, executorId } = SPINE_SEED;
const HASH = "a".repeat(64);

const CHEAP = `${runnerId}.cheap`;
const COMPLEX = `${runnerId}.complex`;

const cert = (o: Partial<NewCertification> = {}): NewCertification => ({
  runner_id: runnerId,
  executor_id: executorId,
  model_id: CHEAP,
  model: `${runnerId}-cheap-model`,
  runner_version: "1",
  suite_version: "1",
  kit_hash: "sha256:kit",
  caps_hash: "sha256:caps",
  result_json: JSON.stringify({ summary: { certifiable: true } }),
  report_path: "/r/fixture-1@local.md",
  gate_eligible: true,
  passed_at: T0,
  ...o,
});

test("a stored pair rolls up into the runners row, and eligibility is per executor", async () => {
  const db = await seeded();
  unwrap(await storeCertification(db, cert()));
  expect(unwrap(await getRunner(db, runnerId))).toMatchObject({
    gate_eligible: 1,
    conformance_passed_at: T0,
    conformance_version: "1",
    conformance_report_path: "/r/fixture-1@local.md",
    conformance_json: '{"certifiable":true}',
  });
  expect(unwrap(await listRunnerEligibility(db, executorId, [CHEAP]))).toEqual([
    { id: runnerId, enabled: 1, gate_eligible: 1, conformance_passed_at: T0 },
  ]);
  // Certified on local says nothing about ctr: that pair has no row.
  expect(unwrap(await listRunnerEligibility(db, "ctr", [CHEAP]))).toEqual([
    { id: runnerId, enabled: 1, gate_eligible: 0, conformance_passed_at: null },
  ]);
});

test("storing again replaces the pair; a non-eligible result clears the roll-up", async () => {
  const db = await seeded();
  unwrap(await storeCertification(db, cert()));
  clock.advance(10);
  unwrap(
    await storeCertification(
      db,
      cert({ runner_version: "2", gate_eligible: false, passed_at: null }),
    ),
  );
  const [row] = unwrap(await listRunnerCertifications(db));
  expect(row).toMatchObject({
    runner_version: "2",
    gate_eligible: 0,
    passed_at: null,
    certified_at: T0 + 10,
  });
  expect(unwrap(await getRunner(db, runnerId))).toMatchObject({
    gate_eligible: 0,
    conformance_passed_at: null,
    conformance_version: "2",
  });
});

test("decertifying clears one pair's flags, keeps its result and first reason, and re-rolls the runner", async () => {
  const db = await seeded();
  unwrap(await storeCertification(db, cert()));
  unwrap(
    await storeCertification(
      db,
      cert({ executor_id: "ctr", passed_at: T0 - 1, report_path: "/r/c.md" }),
    ),
  );
  const pair = {
    runner_id: runnerId,
    executor_id: executorId,
    model_id: CHEAP,
    compression: false,
  };
  const once = { ...pair, reason: "runner_version 1 → 2" };
  expect(unwrap(await decertifyPairs(db, [once]))).toEqual([once]);
  // Already decertified: not written, and not reported again.
  expect(
    unwrap(await decertifyPairs(db, [{ ...pair, reason: "later" }])),
  ).toEqual([]);
  const rows = unwrap(await listRunnerCertifications(db));
  expect(rows.find((r) => r.executor_id === executorId)).toMatchObject({
    gate_eligible: 0,
    passed_at: null,
    decertified_reason: "runner_version 1 → 2",
    result_json: cert().result_json,
  });
  // ctr is still certified: the roll-up is "on at least one executor".
  expect(unwrap(await getRunner(db, runnerId))).toMatchObject({
    gate_eligible: 1,
    conformance_passed_at: T0 - 1,
    conformance_report_path: "/r/c.md",
  });
  unwrap(
    await decertifyPairs(db, [
      {
        runner_id: runnerId,
        executor_id: "ctr",
        model_id: CHEAP,
        compression: false,
        reason: "kit",
      },
    ]),
  );
  expect(unwrap(await getRunner(db, runnerId))).toMatchObject({
    gate_eligible: 0,
    conformance_passed_at: null,
    conformance_version: null,
    conformance_json: null,
  });
  // Storing again certifies the pair afresh.
  unwrap(await storeCertification(db, cert()));
  expect(
    unwrap(await listRunnerCertifications(db)).find(
      (r) => r.executor_id === executorId,
    ),
  ).toMatchObject({ decertified_at: null, decertified_reason: null });
});

test("a certificate holds for its own model alone: another model of the runner is uncertified", async () => {
  const db = await seeded();
  unwrap(await storeCertification(db, cert()));
  expect(
    unwrap(await getLiveCertification(db, runnerId, executorId, CHEAP, false)),
  ).toMatchObject({ model_id: CHEAP, model: `${runnerId}-cheap-model` });
  expect(
    unwrap(
      await getLiveCertification(db, runnerId, executorId, COMPLEX, false),
    ),
  ).toBeNull();
  // The pick asks for the model its reviewer would run: complex has no certificate here.
  expect(
    unwrap(await listRunnerEligibility(db, executorId, [COMPLEX])),
  ).toEqual([
    { id: runnerId, enabled: 1, gate_eligible: 0, conformance_passed_at: null },
  ]);
  expect(unwrap(await listRunnerEligibility(db, executorId, []))).toEqual([
    { id: runnerId, enabled: 1, gate_eligible: 0, conformance_passed_at: null },
  ]);
  // A second model's certificate is a second row; decertifying one leaves the other.
  unwrap(
    await storeCertification(
      db,
      cert({ model_id: COMPLEX, model: `${runnerId}-complex-model` }),
    ),
  );
  expect(unwrap(await listRunnerCertifications(db))).toHaveLength(2);
  unwrap(
    await decertifyPairs(db, [
      {
        runner_id: runnerId,
        executor_id: executorId,
        model_id: COMPLEX,
        compression: false,
        reason: "x",
      },
    ]),
  );
  expect(
    unwrap(
      await getLiveCertification(db, runnerId, executorId, COMPLEX, false),
    ),
  ).toBeNull();
  expect(
    unwrap(await getLiveCertification(db, runnerId, executorId, CHEAP, false)),
  ).not.toBeNull();
  expect(unwrap(await getRunner(db, runnerId))).toMatchObject({
    gate_eligible: 1,
    conformance_passed_at: T0,
  });
});

test("compression is part of the key (049): an ON and an OFF certificate of one model, each answering its own", async () => {
  const db = await seeded();
  // Only the ON certificate: a compressed session is admitted, an uncompressed one is not.
  unwrap(
    await storeCertification(
      db,
      cert({
        compression: true,
        kit_hash: "sha256:kit+ctx1",
        passed_at: T0 + 1,
      }),
    ),
  );
  expect(
    unwrap(await getLiveCertification(db, runnerId, executorId, CHEAP, true)),
  ).toMatchObject({ compression: 1, kit_hash: "sha256:kit+ctx1" });
  expect(
    unwrap(await getLiveCertification(db, runnerId, executorId, CHEAP, false)),
  ).toBeNull();
  // The runner's roll-up is its normal badge: compression-off certificates only.
  expect(unwrap(await getRunner(db, runnerId))).toMatchObject({
    gate_eligible: 0,
    conformance_passed_at: null,
    conformance_version: null,
  });
  // The pick asks for the ON certificate of a compressed model, the OFF one otherwise.
  expect(
    unwrap(await listRunnerEligibility(db, executorId, [CHEAP], [CHEAP])),
  ).toEqual([
    {
      id: runnerId,
      enabled: 1,
      gate_eligible: 1,
      conformance_passed_at: T0 + 1,
    },
  ]);
  expect(unwrap(await listRunnerEligibility(db, executorId, [CHEAP]))).toEqual([
    { id: runnerId, enabled: 1, gate_eligible: 0, conformance_passed_at: null },
  ]);

  // The OFF certificate is a second row beside it, and the roll-up follows it alone.
  unwrap(await storeCertification(db, cert()));
  expect(unwrap(await listRunnerCertifications(db))).toMatchObject([
    { model_id: CHEAP, compression: 0, kit_hash: "sha256:kit" },
    { model_id: CHEAP, compression: 1, kit_hash: "sha256:kit+ctx1" },
  ]);
  expect(unwrap(await getRunner(db, runnerId))).toMatchObject({
    gate_eligible: 1,
    conformance_passed_at: T0,
  });
  expect(
    unwrap(await getLiveCertification(db, runnerId, executorId, CHEAP, false)),
  ).toMatchObject({ compression: 0 });

  // Decertifying the ON one leaves the OFF one live, and the other way round.
  const on = {
    runner_id: runnerId,
    executor_id: executorId,
    model_id: CHEAP,
    compression: true,
    reason: "kit_hash (ruleset)",
  };
  expect(unwrap(await decertifyPairs(db, [on]))).toEqual([on]);
  expect(
    unwrap(await getLiveCertification(db, runnerId, executorId, CHEAP, true)),
  ).toBeNull();
  expect(
    unwrap(await getLiveCertification(db, runnerId, executorId, CHEAP, false)),
  ).not.toBeNull();
  expect(unwrap(await getRunner(db, runnerId))).toMatchObject({
    gate_eligible: 1,
  });
  // Storing the ON one again replaces its own row only.
  unwrap(
    await storeCertification(
      db,
      cert({ compression: true, kit_hash: "sha256:kit+ctx2" }),
    ),
  );
  expect(
    unwrap(await listRunnerCertifications(db)).map((r) => [
      r.compression,
      r.kit_hash,
      r.decertified_at,
    ]),
  ).toEqual([
    [0, "sha256:kit", null],
    [1, "sha256:kit+ctx2", null],
  ]);
});

test("a probe's token works until it is closed or expires; a bad hash is refused", async () => {
  const db = await seeded();
  const open = (token_hash: string) =>
    openConformanceProbe(db, {
      token_hash,
      toolset_hash: "sha256:tools",
      runner_id: runnerId,
      executor_id: executorId,
      expires_at: clock.now() + 1_000,
    });
  expect((await open("not-a-hash")).ok).toBe(false);
  const probe = unwrap(await open(HASH));
  expect(unwrap(await findLiveConformanceProbe(db, HASH))?.id).toBe(probe.id);
  unwrap(await closeConformanceProbe(db, probe.id));
  expect(unwrap(await findLiveConformanceProbe(db, HASH))).toBeNull();
  const second = "b".repeat(64);
  unwrap(await open(second));
  clock.advance(1_000);
  expect(unwrap(await findLiveConformanceProbe(db, second))).toBeNull();
});

test("the scratch identity seeds one agent, and never onto a database that holds sessions", async () => {
  const fresh = unwrap(await tempDb(clock));
  cleanups.push(fresh.cleanup);
  unwrap(
    await upsertRegistration(fresh.db, {
      runner: { id: "r", kind: "script", adapter: "r", caps_json: "{}" },
      models: [],
    }),
  );
  unwrap(
    await upsertExecutor(fresh.db, {
      id: "x",
      kind: "local",
      config_json: "{}",
    }),
  );
  const identity = {
    agent_id: "conformance",
    runner_id: "r",
    executor_id: "x",
  };
  unwrap(await seedConformanceScratch(fresh.db, identity));
  const used = await seeded();
  const refused = await seedConformanceScratch(used, {
    ...identity,
    runner_id: runnerId,
    executor_id: executorId,
  });
  expect(refused.ok ? null : refused.error.class).toBe("validation");
});
