// Decertify at boot and on each registration: a certificate stored from a certifiable
// result holds while nothing moved, and lapses on a changed runner version, caps, kit or suite, a
// renamed or unregistered model (per model, the others untouched), or when its stored
// flags are not what certify() derives from its stored result.
import { readFileSync } from "node:fs";
import {
  CONFORMANCE_TEST_NAMES,
  CONTEXT_RULESET,
  FakeClock,
  GATING_CAP,
  SUITE_VERSION,
  canonicalJson,
  capsHash,
  certificationFlags,
  certify,
  expectedTestIds,
  sha256Hex,
  type JsonValue,
  ok,
  type ConformanceResult,
  type RunnerCaps,
} from "@bayon/core";
import {
  getLiveCertification,
  getRunner,
  listModels,
  listRunnerCertifications,
  type Db,
} from "@bayon/db";
import {
  migrateUp,
  storeCertification,
  upsertExecutor,
  type Decertification,
} from "@bayon/db/supervisor";
import {
  modelRow,
  seedPre045CertificationForTest,
  seedRows,
  tempDb,
  unwrap,
  updateRowForTest,
} from "@bayon/db/testing";
import { registrations, type Registration } from "@bayon/runners";
import {
  SCENARIO_NAMES,
  conformanceKit,
  kitHash,
  type ConformanceKit,
} from "@bayon/runners/conformance";
import { afterAll, expect, test } from "vitest";
import {
  LOCAL_EXECUTOR_ID,
  registrationRows,
  upsertBootRows,
} from "../boot.js";

const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

const REGISTERED = registrations();
const fixture = (): Registration => {
  const r = REGISTERED.find((x) => x.runner.id === "fixture");
  if (r === undefined) throw new Error("no fixture registration");
  return r;
};
const kit = () => unwrap(conformanceKit("fixture"));

/** A certify()'d result for the fixture as registered now; `fail` fails one test. */
const CHEAP = "fixture.cheap";
const COMPLEX = "fixture.complex";
/** The model string the fixture registers under `id`. */
const modelOf = (id: string): string => {
  const m = fixture().models.find((x) => x.id === id);
  if (m === undefined) throw new Error(`no fixture model ${id}`);
  return m.model;
};

async function result(
  o: {
    readonly suite?: string;
    readonly fail?: number;
    readonly model?: string;
    /** Earned with context compression on, under this ruleset: test 17 too. */
    readonly compression?: string;
  } = {},
): Promise<ConformanceResult> {
  const caps: RunnerCaps = fixture().runner.caps;
  const compression =
    o.compression === undefined ? undefined : { ruleset: o.compression };
  const tests = expectedTestIds(compression !== undefined).map((id) => {
    const cap = GATING_CAP[id];
    const na = cap !== undefined && !caps[cap];
    const failed = id === o.fail;
    return {
      id,
      name: CONFORMANCE_TEST_NAMES[id],
      status: failed ? "fail" : na ? "na" : "pass",
      attempts: 1,
      duration_ms: 1,
      fallback: na && !failed ? "held" : null,
      checks: [{ name: "held", ok: !failed, detail: null }],
    } as const;
  });
  return unwrap(
    certify({
      schema: 1,
      suite_version: o.suite ?? SUITE_VERSION,
      runner_id: "fixture",
      runner_version: fixture().runner.versionDetected,
      model: o.model ?? modelOf(CHEAP),
      executor: { id: "local", kind: "local" },
      started_at: 1_000,
      finished_at: 2_000,
      // The kit hashed with the cheap model: a result naming another model still carries it.
      kit_hash: await kitHash(kit(), modelOf(CHEAP), {}, compression),
      ...(compression === undefined ? {} : { compression }),
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

/** A booted database holding the fixture's certification on local, on `modelId` (default cheap). */
async function certified(
  r: ConformanceResult,
  forged: Partial<{ gate_eligible: boolean }> = {},
  modelId = CHEAP,
  into?: Db,
  rowModel?: string,
): Promise<Db> {
  const db = into ?? (await freshDb());
  unwrap(
    await storeCertification(db, {
      runner_id: "fixture",
      executor_id: "local",
      model_id: modelId,
      compression: r.compression !== null,
      model: rowModel ?? r.model ?? "none",
      runner_version: r.runner_version,
      suite_version: r.suite_version,
      kit_hash: r.kit_hash,
      caps_hash: await capsHash(r.caps),
      result_json: JSON.stringify(r),
      report_path: "/r/fixture-1@local.md",
      ...certificationFlags(r),
      ...forged,
    }),
  );
  return db;
}

async function freshDb(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await upsertBootRows(t.db, { registrations: REGISTERED }));
  return t.db;
}

/** Boots with `regs`, returning what it decertified. */
async function boot(
  db: Db,
  regs: readonly Registration[],
  kits = conformanceKit,
): Promise<Decertification[]> {
  const told: Decertification[] = [];
  unwrap(
    await upsertBootRows(db, {
      registrations: regs,
      kits,
      onDecertified: (d) => told.push(d),
    }),
  );
  return told;
}

const withFixture = (patch: Partial<Registration["runner"]>) =>
  REGISTERED.map((r) =>
    r.runner.id === "fixture" ? { ...r, runner: { ...r.runner, ...patch } } : r,
  );

test("a boot that changes nothing keeps the pair and its roll-up", async () => {
  const db = await certified(await result());
  expect(await boot(db, REGISTERED)).toEqual([]);
  expect(unwrap(await getRunner(db, "fixture"))).toMatchObject({
    gate_eligible: 1,
    conformance_passed_at: 2_000,
  });
});

test("a changed runner version decertifies the pair and clears the roll-up", async () => {
  const db = await certified(await result());
  const version = fixture().runner.versionDetected;
  expect(await boot(db, withFixture({ versionDetected: "999" }))).toEqual([
    {
      runner_id: "fixture",
      executor_id: "local",
      model_id: CHEAP,
      compression: false,
      reason: `runner_version ${version} → 999`,
    },
  ]);
  const [pair] = unwrap(await listRunnerCertifications(db));
  expect(pair).toMatchObject({ gate_eligible: 0, passed_at: null });
  expect(pair?.decertified_reason).toMatch(/^runner_version /);
  expect(unwrap(await getRunner(db, "fixture"))).toMatchObject({
    gate_eligible: 0,
    conformance_passed_at: null,
  });
});

test("changed caps, a changed kit or another suite version decertify it too", async () => {
  const caps = fixture().runner.caps;
  const flipped = await certified(await result());
  const [byCaps] = await boot(
    flipped,
    withFixture({ caps: { ...caps, hooks: !caps.hooks } }),
  );
  expect(byCaps?.reason).toMatch(/^caps_hash /);

  const rekitted = await certified(await result());
  const [byKit] = await boot(rekitted, REGISTERED, () =>
    ok({ ...kit(), unknownLines: () => [{ another: "line" }] }),
  );
  expect(byKit?.reason).toMatch(/^kit_hash /);

  const older = await certified(await result({ suite: "0" }));
  const [bySuite] = await boot(older, REGISTERED);
  expect(bySuite?.reason).toBe(`suite_version 0 → ${SUITE_VERSION}`);
});

test("per model: a renamed model lapses its own certificate; another model's holds", async () => {
  const db = await certified(await result());
  await certified(await result({ model: modelOf(COMPLEX) }), {}, COMPLEX, db);
  const renamed = REGISTERED.map((r) =>
    r.runner.id === "fixture"
      ? {
          ...r,
          models: r.models.map((m) =>
            m.id === COMPLEX ? { ...m, model: "fixture-model-2" } : m,
          ),
        }
      : r,
  );
  expect(await boot(db, renamed)).toEqual([
    {
      runner_id: "fixture",
      executor_id: "local",
      model_id: COMPLEX,
      compression: false,
      reason: expect.stringMatching(
        new RegExp(`^model ${modelOf(COMPLEX)} → fixture-model-2; kit_hash `),
      ),
    },
  ]);
  const rows = unwrap(await listRunnerCertifications(db));
  expect(rows.find((r) => r.model_id === CHEAP)).toMatchObject({
    decertified_at: null,
  });
  expect(unwrap(await getRunner(db, "fixture"))).toMatchObject({
    gate_eligible: 1,
  });
});

test("an operator's own model keeps its certificate across a boot: it is judged on its stored string", async () => {
  const db = await freshDb();
  const own = "fixture-own-model";
  unwrap(
    await seedRows(db, {
      models: [
        modelRow("fixture", "standard", {
          id: "fixture.own",
          model: own,
          active: 0,
          source: "operator",
        }),
      ],
    }),
  );
  // A result for the operator's model, hashed with it as the suite would hash it.
  const earned = await result({ model: own });
  await certified(
    { ...earned, kit_hash: await kitHash(kit(), own) },
    {},
    "fixture.own",
    db,
  );
  expect(await boot(db, REGISTERED)).toEqual([]);
  expect(
    unwrap(await listRunnerCertifications(db)).find(
      (r) => r.model_id === "fixture.own",
    ),
  ).toMatchObject({ decertified_at: null });
});

test("an operator model's changed provider URL lapses its certificate, naming its settings; empty settings hash as before", async () => {
  const db = await freshDb();
  const own = "fixture-own-url-model";
  const at = (url: string) => JSON.stringify({ provider_url: url });
  unwrap(
    await seedRows(db, {
      models: [
        modelRow("fixture", "standard", {
          id: "fixture.url",
          model: own,
          active: 0,
          source: "operator",
          settings_json: at("http://10.0.0.7:11434/v1"),
        }),
      ],
    }),
  );
  const earned = await result({ model: own });
  await certified(
    {
      ...earned,
      kit_hash: await kitHash(kit(), own, {
        provider_url: "http://10.0.0.7:11434/v1",
      }),
    },
    {},
    "fixture.url",
    db,
  );
  // The cheap tier's certificate, earned with no settings, sits beside it.
  await certified(await result(), {}, CHEAP, db);
  expect(await boot(db, REGISTERED)).toEqual([]);

  unwrap(
    await updateRowForTest(db, "models", "fixture.url", {
      settings_json: at("http://10.0.0.8:11434/v1"),
    }),
  );
  const told = await boot(db, REGISTERED);
  expect(told).toHaveLength(1);
  expect(told[0]).toMatchObject({ model_id: "fixture.url" });
  expect(told[0]?.reason).toMatch(/^kit_hash /);
  expect(told[0]?.reason).toContain(
    `the kit hash covers the model's settings, now ${at("http://10.0.0.8:11434/v1")}`,
  );
  expect(
    unwrap(await listRunnerCertifications(db)).find(
      (r) => r.model_id === CHEAP,
    ),
  ).toMatchObject({ decertified_at: null });
});

test("kitHash: no settings and {} hash exactly as before; settings change it, whatever their key order", async () => {
  const k = kit();
  const m = modelOf(CHEAP);
  expect(await kitHash(k, m, {})).toBe(await kitHash(k, m));
  expect(await kitHash(k, m)).toBe(await pre045KitHash(k, m));
  const a = await kitHash(k, m, { provider_url: "http://10.0.0.7/", x: 1 });
  expect(a).not.toBe(await kitHash(k, m));
  expect(await kitHash(k, m, { x: 1, provider_url: "http://10.0.0.7/" })).toBe(
    a,
  );
});

test("a model no longer registered decertifies its certificate, naming it", async () => {
  const db = await certified(await result());
  const retired = REGISTERED.map((r) =>
    r.runner.id === "fixture"
      ? { ...r, models: r.models.filter((m) => m.id !== CHEAP) }
      : r,
  );
  const [gone] = await boot(db, retired);
  expect(gone).toEqual({
    runner_id: "fixture",
    executor_id: "local",
    model_id: CHEAP,
    compression: false,
    reason: "model fixture.cheap is no longer registered for runner fixture",
  });
});

// a tier moves to a new model and keeps the old row on standby. The old row's string is
// unchanged, so its certificate holds and switching back needs none; its window changes, which no
// hash covers. The new row is a new model: uncertified until the operator certifies it.
test("a row put on standby keeps its certificate, a new window or not; the tier's new row has none", async () => {
  const db = await certified(await result());
  const cheapRow = fixture().models.find((m) => m.id === CHEAP);
  if (cheapRow === undefined) throw new Error("no cheap row");
  const moved = REGISTERED.map((r) =>
    r.runner.id === "fixture"
      ? {
          ...r,
          models: [
            ...r.models.map((m) =>
              m.id === CHEAP
                ? { ...m, standby: true, contextTokens: m.contextTokens + 1 }
                : m,
            ),
            { ...cheapRow, id: `${CHEAP}-next`, model: "fixture-model-next" },
          ],
        }
      : r,
  );
  expect(await boot(db, moved)).toEqual([]);
  expect(
    unwrap(await getLiveCertification(db, "fixture", "local", CHEAP, false)),
  ).toMatchObject({ model_id: CHEAP, passed_at: 2_000 });
  expect(
    unwrap(
      await getLiveCertification(
        db,
        "fixture",
        "local",
        `${CHEAP}-next`,
        false,
      ),
    ),
  ).toBeNull();
  const cheap = unwrap(await listModels(db)).filter(
    (m) => m.runner_id === "fixture" && m.tier === "cheap",
  );
  expect(cheap.map((m) => [m.id, m.active, m.standby])).toEqual([
    [CHEAP, 0, 1],
    [`${CHEAP}-next`, 1, 0],
  ]);
});

test("a certificate stored on one model with another model's result lapses", async () => {
  const db = await certified(
    await result({ model: "some-other-model" }),
    {},
    CHEAP,
    undefined,
    modelOf(CHEAP),
  );
  const [other] = await boot(db, REGISTERED);
  expect(other?.reason).toBe(
    `the stored result is for another key: model ${modelOf(CHEAP)} → some-other-model`,
  );
});

/**
 * The kit hash exactly as the suite computed it before, with the kit's own (cheapest)
 * model: written out here, independent of today's kitHash, so the test holds that function to it.
 */
async function pre045KitHash(
  k: ConformanceKit,
  kitModel: string,
): Promise<string> {
  const placeholders = {
    nonce: "{nonce}",
    mcpTool: "{mcpTool}",
    marker: "{marker}",
    roots: ["{root}"],
    outside: "{outside}",
    rootMarker: "{rootMarker}",
  };
  const described = {
    runnerId: k.runnerId,
    model: kitModel,
    scenarios: Object.fromEntries(
      SCENARIO_NAMES.map((name) => [name, k.scenario(name, placeholders)]),
    ),
    unknownLines: k.unknownLines(placeholders.nonce),
    grantsExtraRoots: Object.fromEntries(
      (["local", "container", "remote"] as const).map((kind) => [
        kind,
        k.grantsExtraRoots(kind),
      ]),
    ),
  };
  const json: JsonValue = JSON.parse(JSON.stringify(described));
  return `sha256:${await sha256Hex(canonicalJson(json))}`;
}

test("a certificate stored before 045 survives the migration and the boot for the model it was earned on, and no other (spec v67)", async () => {
  const t = unwrap(await tempDb(clock, { to: 44 }));
  cleanups.push(t.cleanup);
  // A 044 database as a booted supervisor left it: the fixture's rows and the local executor.
  // Seeded as rows (today's upsertRegistration writes 046's models.source and 050's standby, which
  // 044 has not).
  const rows = unwrap(registrationRows(fixture()));
  unwrap(
    await seedRows(t.db, {
      runners: [rows.runner],
      models: rows.models.map((m) => ({
        ...Object.fromEntries(
          Object.entries(m).filter(([key]) => key !== "standby"),
        ),
        id: m.id,
        tier: m.tier,
        model: m.model,
        runner_id: rows.runner.id,
        active: 1,
      })),
    }),
  );
  unwrap(
    await upsertExecutor(t.db, {
      id: LOCAL_EXECUTOR_ID,
      kind: "local",
      config_json: "{}",
    }),
  );
  // Its certificate, stored the old way: the kit hash over the kit's cheapest model, a result
  // that names no model.
  const r = await result();
  const legacy = Object.fromEntries(
    Object.entries(r).filter(([key]) => key !== "model"),
  );
  const flags = certificationFlags(r);
  unwrap(
    await seedPre045CertificationForTest(t.db, {
      runner_id: "fixture",
      executor_id: "local",
      runner_version: r.runner_version,
      suite_version: r.suite_version,
      kit_hash: await pre045KitHash(kit(), modelOf(CHEAP)),
      caps_hash: await capsHash(r.caps),
      result_json: JSON.stringify({
        ...legacy,
        kit_hash: await pre045KitHash(kit(), modelOf(CHEAP)),
      }),
      gate_eligible: flags.gate_eligible ? 1 : 0,
      passed_at: flags.passed_at,
      certified_at: 2_000,
    }),
  );

  unwrap(await migrateUp(t.db));
  expect(await boot(t.db, REGISTERED)).toEqual([]);
  expect(
    unwrap(await getLiveCertification(t.db, "fixture", "local", CHEAP, false)),
  ).toMatchObject({ model_id: CHEAP, passed_at: 2_000 });
  // Every other model of the runner is uncertified: the certificate was earned on the cheap one.
  for (const other of fixture().models.filter((m) => m.id !== CHEAP)) {
    expect(
      unwrap(
        await getLiveCertification(t.db, "fixture", "local", other.id, false),
      ),
      other.id,
    ).toBeNull();
  }
});

test("stored flags that certify() would not give lapse the pair", async () => {
  const db = await certified(await result({ fail: 4 }), {
    gate_eligible: true,
  });
  const [forged] = await boot(db, REGISTERED);
  expect(forged?.reason).toBe(
    "the stored flags disagree with the stored result",
  );
});

// `pairId` joins on a NUL. Written as a literal byte instead of the escape `\0`
// it makes git call the whole file binary, and change to it rendered as "Binary files
// differ": a diff nobody can review is a change nobody should merge.
test("the module is text to git: not one NUL byte in its source", () => {
  const source = readFileSync(new URL("./decertify.ts", import.meta.url));
  expect(source.indexOf(0)).toBe(-1);
});

test("a new context ruleset lapses the compression-on certificates alone; the off ones hold", async () => {
  // The same model certified three ways: off, on under this build's ruleset, on under an old one
  // (a second database, as one key holds one row).
  const db = await certified(await result());
  await certified(
    await result({ compression: CONTEXT_RULESET }),
    {},
    CHEAP,
    db,
  );
  expect(
    unwrap(await listRunnerCertifications(db)).map((c) => c.compression),
  ).toEqual([0, 1]);
  // This build's ruleset: both hold.
  expect(await boot(db, REGISTERED)).toEqual([]);

  const stale = await certified(await result());
  await certified(await result({ compression: "ctx0" }), {}, CHEAP, stale);
  const lapsed = await boot(stale, REGISTERED);
  expect(lapsed).toEqual([
    {
      runner_id: "fixture",
      executor_id: "local",
      model_id: CHEAP,
      compression: true,
      reason: expect.stringContaining("kit_hash"),
    },
  ]);
  expect(
    unwrap(await getLiveCertification(stale, "fixture", "local", CHEAP, true)),
  ).toBeNull();
  expect(
    unwrap(await getLiveCertification(stale, "fixture", "local", CHEAP, false)),
  ).toMatchObject({ compression: 0, passed_at: 2_000 });
  // The runner's roll-up is its compression-off certificate, which still holds.
  expect(unwrap(await getRunner(stale, "fixture"))).toMatchObject({
    gate_eligible: 1,
    conformance_passed_at: 2_000,
  });
});
