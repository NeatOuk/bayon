import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp } from "./migrate.js";
import { getRunner } from "./repos/config.js";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "./testing.js";

// 009_conformance: runner_certifications keyed by (runner, executor), conformance_probes,
// and the runners conformance columns cleared into a roll-up of the pairs.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const raw = (db: Db) => unwrap(internalsOf(db)).raw;

const tables = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('runner_certifications', 'conformance_probes') ORDER BY name",
        )
        .pluck()
        .all(),
    );

const insertPair = (db: Db) =>
  raw(db).prepare(
    `INSERT INTO runner_certifications (runner_id, executor_id, runner_version, suite_version,
       kit_hash, caps_hash, result_json, gate_eligible, passed_at, certified_at, decertified_at)
     VALUES (?, ?, '1', '1', 'k', 'c', '{}', ?, ?, 0, ?)`,
  );

test("009 on an empty database: both tables, the pair key, the decertified CHECK and the FKs", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 9 }));
  expect(tables(db)).toEqual(["conformance_probes", "runner_certifications"]);
  unwrap(await seedSpine(db, 9));
  const pair = insertPair(db);
  pair.run(SPINE_SEED.runnerId, SPINE_SEED.executorId, 1, 5, null);
  expect(() =>
    pair.run(SPINE_SEED.runnerId, SPINE_SEED.executorId, 0, null, null),
  ).toThrow(/UNIQUE constraint failed/);
  expect(() =>
    pair.run(SPINE_SEED.runnerId, "no-such-executor", 0, null, null),
  ).toThrow(/FOREIGN KEY/);
  // Decertified means no flags: the CHECK holds the pair to it.
  raw(db).prepare("DELETE FROM runner_certifications").run();
  expect(() =>
    pair.run(SPINE_SEED.runnerId, SPINE_SEED.executorId, 1, null, 9),
  ).toThrow(/CHECK constraint failed/);
  expect(() =>
    pair.run(SPINE_SEED.runnerId, SPINE_SEED.executorId, 0, 5, 9),
  ).toThrow(/CHECK constraint failed/);
  pair.run(SPINE_SEED.runnerId, SPINE_SEED.executorId, 0, null, 9);
  const probe = raw(db).prepare(
    `INSERT INTO conformance_probes (id, token_hash, toolset_hash, runner_id, executor_id,
       created_at, expires_at) VALUES (?, ?, 't', ?, ?, 0, 1)`,
  );
  probe.run("p1", "h", SPINE_SEED.runnerId, SPINE_SEED.executorId);
  expect(() =>
    probe.run("p2", "h", SPINE_SEED.runnerId, SPINE_SEED.executorId),
  ).toThrow(/UNIQUE constraint failed/);
});

test("009 on a seeded database keeps every runner and clears the conformance columns nothing backs", async () => {
  const db = await dbAt(8);
  unwrap(await seedSpine(db, 8));
  raw(db)
    .prepare(
      `UPDATE runners SET gate_eligible = 1, conformance_passed_at = 5, conformance_version = '1',
         conformance_report_path = 'r.md', conformance_json = '{}' WHERE id = ?`,
    )
    .run(SPINE_SEED.runnerId);
  const before = unwrap(await getRunner(db, SPINE_SEED.runnerId));
  unwrap(await migrateUp(db, { to: 9 }));
  expect(unwrap(await getRunner(db, SPINE_SEED.runnerId))).toEqual({
    ...before,
    gate_eligible: 0,
    conformance_passed_at: null,
    conformance_version: null,
    conformance_report_path: null,
    conformance_json: null,
  });
});

test("009 down drops both tables, and up applies again", async () => {
  const db = await dbAt(9);
  unwrap(await migrateDown(db));
  expect(tables(db)).toEqual([]);
  unwrap(await migrateUp(db, { to: 9 }));
  expect(tables(db)).toEqual(["conformance_probes", "runner_certifications"]);
});
