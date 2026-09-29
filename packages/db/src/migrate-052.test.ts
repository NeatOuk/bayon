import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { dumpAllRows, seedSpine, tempDb, unwrap } from "./testing.js";

// 052_drift_rounds_max: one settings row, gates.drift_rounds_max = 3, kept when already
// set; down deletes it and nothing else.
const THIS = 52;
const KEY = "gates.drift_rounds_max";
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
const valueOf = (db: Db): unknown =>
  raw(db)
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .pluck()
    .get(KEY);

test("052 on an empty database: the row is 3; down removes it; up again", async () => {
  const db = await dbAt(THIS - 1);
  expect(valueOf(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(valueOf(db)).toBe("3");
  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(valueOf(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: THIS }));
  expect(valueOf(db)).toBe("3");
});

test("052 on a seeded database: an operator's value is kept; every other row is untouched", async () => {
  const db = await dbAt(THIS - 1);
  unwrap(await seedSpine(db, THIS - 1));
  raw(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, '5', 1)",
    )
    .run(KEY);
  const before = unwrap(await dumpAllRows(db));
  unwrap(await migrateUp(db, { to: THIS }));
  expect(valueOf(db)).toBe("5");
  const after = unwrap(await dumpAllRows(db));
  const withoutMigrations = (rows: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(rows).filter(([table]) => table !== "_migrations"),
    );
  expect(withoutMigrations(after)).toEqual(withoutMigrations(before));
  unwrap(await migrateDown(db));
  expect(valueOf(db)).toBeUndefined();
});
