import { mkdtempSync, rmSync } from "node:fs";
import { FakeClock, RunnerCaps } from "@bayon/core";
import { listExecutors, listModels, listRunners, openDb } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { registrations } from "@bayon/runners";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import {
  LOCAL_EXECUTOR_ID,
  LOCAL_EXECUTOR_SLOTS,
  registrationRows,
  upsertBootRows,
} from "./boot.js";
import { dbPath } from "./paths.js";
import { startSupervisor } from "./supervisor.js";

const T0 = 1_700_000_000_000;
const home = mkdtempSync("/tmp/frm-");
afterAll(() => rmSync(home, { recursive: true, force: true }));
const log = pino({ level: "silent" });

async function rows() {
  const db = unwrap(
    await openDb({ path: dbPath(home), clock: new FakeClock(T0) }),
  );
  const found = {
    runners: unwrap(await listRunners(db)),
    models: unwrap(await listModels(db)),
    executors: unwrap(await listExecutors(db)),
  };
  unwrap(await db.close());
  return found;
}

async function bootOnce(): Promise<void> {
  const sup = unwrap(
    await startSupervisor({
      home,
      clock: new FakeClock(T0),
      log,
      version: "0.1.0",
    }),
  );
  await sup.shutdown();
}

test("a fresh boot registers every adapter's rows and the local executor; a second boot changes nothing", async () => {
  await bootOnce();
  const first = await rows();
  const expected = registrations();
  expect(first.runners.map((r) => r.id)).toEqual(
    expected.map((r) => r.runner.id).toSorted(),
  );
  for (const r of first.runners) {
    expect(RunnerCaps.safeParse(JSON.parse(r.caps_json)).success).toBe(true);
    expect(r.enabled).toBe(1);
  }
  expect(first.models.map((m) => m.id)).toEqual(
    expected.flatMap((r) => r.models.map((m) => m.id)).toSorted(),
  );
  // Every registered row is active but the ones a registration keeps on standby.
  const standby = new Set(
    expected.flatMap((r) =>
      r.models.filter((m) => m.standby === true).map((m) => m.id),
    ),
  );
  expect(first.models.map((m) => [m.id, m.active, m.standby === 1])).toEqual(
    first.models.map((m) => [
      m.id,
      standby.has(m.id) ? 0 : 1,
      standby.has(m.id),
    ]),
  );
  expect(first.executors).toMatchObject([
    {
      id: LOCAL_EXECUTOR_ID,
      kind: "local",
      slots: LOCAL_EXECUTOR_SLOTS,
      trust: "trusted",
      egress_policy: "open",
      enabled: 1,
    },
  ]);
  expect(JSON.parse(first.executors[0]?.config_json ?? "{}")).toEqual({
    healthArgv: [process.execPath, "-e", ""],
  });

  await bootOnce();
  expect(await rows()).toEqual(first);
});

test("boot makes a local executor registered untrusted trusted, and leaves the operator's other executors alone (M3 trust rule)", async () => {
  const t = unwrap(await tempDb(new FakeClock(T0)));
  try {
    unwrap(
      await seedRows(t.db, {
        executors: [
          // The schema defaults a pre-M3 boot left: untrusted, allowlist.
          { id: LOCAL_EXECUTOR_ID, kind: "local", config_json: "{}" },
          {
            id: "ctr-1",
            kind: "container",
            config_json: "{}",
            trust: "untrusted",
            egress_policy: "allowlist",
          },
        ],
      }),
    );
    unwrap(await upsertBootRows(t.db, { registrations: [] }));
    const byId = new Map(
      unwrap(await listExecutors(t.db)).map((e) => [e.id, e]),
    );
    expect(byId.get(LOCAL_EXECUTOR_ID)).toMatchObject({
      trust: "trusted",
      egress_policy: "open",
    });
    expect(byId.get("ctr-1")).toMatchObject({
      trust: "untrusted",
      egress_policy: "allowlist",
    });
  } finally {
    t.cleanup();
  }
});

// models_tier_idx allows one active row per (runner, tier), so a registration names the
// one: every other row of the tier is on standby. Two that are not is refused before any write.
test("a registration with two active rows in one tier is refused, naming the tier", () => {
  const [base] = registrations();
  if (base === undefined) throw new Error("no registration");
  const [first] = base.models;
  if (first === undefined) throw new Error("no model");
  const twin = { ...first, id: `${first.id}-twin`, standby: false };
  const refused = registrationRows({ ...base, models: [...base.models, twin] });
  expect(refused).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(!refused.ok && refused.error.message).toContain(
    `in tier ${first.tier}: put all but one on standby`,
  );
  const kept = registrationRows({
    ...base,
    models: [...base.models, { ...twin, standby: true }],
  });
  expect(kept.ok && kept.value.models.at(-1)).toMatchObject({
    id: twin.id,
    standby: 1,
  });
});
