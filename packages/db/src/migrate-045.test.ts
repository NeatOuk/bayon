import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import {
  SPINE_SEED,
  dumpAllRows,
  modelRow,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "./testing.js";

// 045_model_certifications: certification per (runner, executor, model). Both tables are
// rebuilt with model_id (and the certificate's model string); an existing row keeps the model it was
// earned on — its runner's cheap tier (active first), else the cheapest, then the lowest id. A runner
// with no models row loses its rows. Down is 044's schema byte for byte, one row per pair again.
const THIS = 45;
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const raw = (db: Db) => unwrap(internalsOf(db)).raw;
const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const TABLES = ["conformance_probes", "runner_certifications"];

/** The stored schema text of both tables and their indexes: what down must restore exactly. */
const schemaText = (db: Db): unknown[] =>
  raw(db)
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE tbl_name IN ('runner_certifications', 'conformance_probes') ORDER BY name`,
    )
    .all();

const columns = (db: Db, table: string): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .pluck()
        .all(),
    );

const keyOf = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(
          "SELECT name FROM pragma_table_info('runner_certifications') WHERE pk > 0 ORDER BY pk",
        )
        .pluck()
        .all(),
    );

const rowsOf = (db: Db, table: string): unknown[] =>
  raw(db).prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all();

test("045 on an empty database: the model joins the key; down is 044's text; up again", async () => {
  const db = await dbAt(THIS - 1);
  const before = schemaText(db);
  expect(keyOf(db)).toEqual(["runner_id", "executor_id"]);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(keyOf(db)).toEqual(["runner_id", "executor_id", "model_id"]);
  expect(columns(db, "runner_certifications")).toContain("model");
  expect(columns(db, "conformance_probes")).toContain("model_id");
  // No leftovers of the rebuild.
  expect(
    raw(db)
      .prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_044'")
      .all(),
  ).toEqual([]);
  // The model must be a models row.
  unwrap(await seedSpine(db, THIS));
  expect(() =>
    raw(db)
      .prepare(
        `INSERT INTO runner_certifications (runner_id, executor_id, model_id, model,
           runner_version, suite_version, kit_hash, caps_hash, result_json, certified_at)
         VALUES (?, ?, 'no-such-model', 'm', '1', '1', 'k', 'c', '{}', 0)`,
      )
      .run(SPINE_SEED.runnerId, SPINE_SEED.executorId),
  ).toThrow(/FOREIGN KEY/);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(schemaText(db)).toEqual(before);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
});

const cert044 = (runnerId: string, executorId: string, at: number) => ({
  runner_id: runnerId,
  executor_id: executorId,
  runner_version: `v-${runnerId}`,
  suite_version: "2",
  kit_hash: `sha256:kit-${runnerId}`,
  caps_hash: "sha256:caps",
  result_json: `{"runner":"${runnerId}"}`,
  report_path: `/r/${runnerId}.md`,
  gate_eligible: 1,
  passed_at: at,
  certified_at: at,
});

/**
 * A 044 database: the spine's runner with an active and a retired cheap row beside its other tiers;
 * runner r2 with no cheap tier (the cheaper of two stands in); runner r3 with no models at all.
 */
async function seeded044(): Promise<Db> {
  const db = await dbAt(THIS - 1);
  unwrap(await seedSpine(db, THIS - 1));
  const { runnerId, executorId } = SPINE_SEED;
  unwrap(
    await seedRows(db, {
      runners: [
        { id: "r2", kind: "script", adapter: "r2", caps_json: "{}" },
        { id: "r3", kind: "script", adapter: "r3", caps_json: "{}" },
      ],
      executors: [{ id: "ctr", kind: "container", config_json: "{}" }],
      models: [
        modelRow(runnerId, "complex"),
        // Retired, and first by id: the active cheap row still wins.
        modelRow(runnerId, "cheap", {
          id: `${runnerId}.a-cheap-old`,
          model: "old-cheap",
          active: 0,
        }),
        modelRow(runnerId, "cheap"),
        modelRow(runnerId, "standard"),
        modelRow("r2", "complex", { price_in_per_mtok: 20 }),
        modelRow("r2", "standard", { price_in_per_mtok: 4 }),
      ],
      conformance_probes: [
        {
          id: "P-1",
          token_hash: "h1",
          toolset_hash: "t",
          runner_id: runnerId,
          executor_id: executorId,
          created_at: 1,
          expires_at: 2,
        },
        {
          id: "P-3",
          token_hash: "h3",
          toolset_hash: "t",
          runner_id: "r3",
          executor_id: executorId,
          created_at: 1,
          expires_at: 2,
        },
      ],
    }),
  );
  // 044's rows, as 044 held them: the current schema's types have a model the old table had not.
  const insert = raw(db).prepare(
    `INSERT INTO runner_certifications (runner_id, executor_id, runner_version, suite_version,
       kit_hash, caps_hash, result_json, report_path, gate_eligible, passed_at, certified_at)
     VALUES (@runner_id, @executor_id, @runner_version, @suite_version, @kit_hash, @caps_hash,
       @result_json, @report_path, @gate_eligible, @passed_at, @certified_at)`,
  );
  for (const row of [
    cert044(runnerId, executorId, 10),
    cert044(runnerId, "ctr", 11),
    cert044("r2", executorId, 12),
    cert044("r3", executorId, 13),
  ]) {
    insert.run(row);
  }
  return db;
}

test("045 on a seeded database: each certificate keeps the model it was earned on", async () => {
  const db = await seeded044();
  const { runnerId, executorId } = SPINE_SEED;
  const before = rowsOf(db, "runner_certifications");
  const others = Object.entries(unwrap(await dumpAllRows(db))).filter(
    ([table]) => ![...TABLES, "_migrations"].includes(table),
  );

  unwrap(await migrateUp(db, { to: THIS }));
  const mapped = raw(db)
    .prepare(
      "SELECT runner_id, executor_id, model_id, model FROM runner_certifications ORDER BY 1, 2",
    )
    .all();
  expect(mapped).toEqual([
    {
      runner_id: runnerId,
      executor_id: "ctr",
      model_id: `${runnerId}.cheap`,
      model: `${runnerId}-cheap-model`,
    },
    {
      runner_id: runnerId,
      executor_id: executorId,
      model_id: `${runnerId}.cheap`,
      model: `${runnerId}-cheap-model`,
    },
    // No cheap tier: the cheapest row.
    {
      runner_id: "r2",
      executor_id: executorId,
      model_id: "r2.standard",
      model: "r2-standard-model",
    },
    // r3 has no model a certificate could have been earned on: its row is gone.
  ]);
  // Every other column carried over untouched.
  const kept = raw(db)
    .prepare(
      `SELECT runner_id, executor_id, runner_version, suite_version, kit_hash, caps_hash,
              result_json, report_path, gate_eligible, passed_at, certified_at, decertified_at,
              decertified_reason
       FROM runner_certifications ORDER BY 1, 2, 3`,
    )
    .all();
  expect(kept).toEqual(
    before.filter((r) => (r as { runner_id: string }).runner_id !== "r3"),
  );
  expect(
    raw(db)
      .prepare("SELECT id, model_id FROM conformance_probes ORDER BY id")
      .all(),
  ).toEqual([
    { id: "P-1", model_id: `${runnerId}.cheap` },
    { id: "P-3", model_id: null },
  ]);
  // A second model's certificate is a row of its own now.
  raw(db)
    .prepare(
      `INSERT INTO runner_certifications (runner_id, executor_id, model_id, model,
         runner_version, suite_version, kit_hash, caps_hash, result_json, certified_at)
       VALUES (?, ?, ?, 'm', '1', '1', 'k', 'c', '{}', 99)`,
    )
    .run(runnerId, executorId, `${runnerId}.complex`);
  // Only the two rebuilt tables changed.
  expect(
    Object.entries(unwrap(await dumpAllRows(db))).filter(
      ([table]) => ![...TABLES, "_migrations"].includes(table),
    ),
  ).toEqual(others);

  // Down: one row per pair, the cheap tier's kept over the newer complex one; probes whole.
  unwrap(await migrateDown(db));
  expect(rowsOf(db, "runner_certifications")).toEqual(
    before.filter((r) => (r as { runner_id: string }).runner_id !== "r3"),
  );
  expect(
    raw(db)
      .prepare("SELECT id FROM conformance_probes ORDER BY id")
      .pluck()
      .all(),
  ).toEqual(["P-1", "P-3"]);
});

test("045 down with only another model's row for a pair keeps the newest", async () => {
  const db = await dbAt(THIS);
  unwrap(await seedSpine(db, THIS));
  const { runnerId, executorId } = SPINE_SEED;
  unwrap(
    await seedRows(db, {
      models: [
        modelRow(runnerId, "cheap"),
        modelRow(runnerId, "standard"),
        modelRow(runnerId, "complex"),
      ],
      runner_certifications: [
        {
          ...cert044(runnerId, executorId, 20),
          model_id: `${runnerId}.standard`,
          model: "s",
        },
        {
          ...cert044(runnerId, executorId, 30),
          model_id: `${runnerId}.complex`,
          model: "c",
        },
      ],
    }),
  );
  unwrap(await migrateDown(db));
  expect(
    raw(db)
      .prepare("SELECT runner_id, certified_at FROM runner_certifications")
      .all(),
  ).toEqual([{ runner_id: runnerId, certified_at: 30 }]);
});
