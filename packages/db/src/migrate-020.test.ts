import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import type { Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { getSettings } from "./repos/config.js";
import { seedRows, seedSpine, tempDb, unwrap } from "./testing.js";

// 020_parity_check: the operator's switch for the parity_check gate, seeded off.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const KEY = "gates.parity_check";
const OTHERS = ["gates.wall_clock_ms", "gates.base_drift"];

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const parity = async (db: Db) => unwrap(await getSettings(db, [KEY])).get(KEY);

test("020 on an empty database seeds gates.parity_check = false", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 20 }));
  // Off is the safe state: the gate opens for nobody until an operator turns it on.
  expect(await parity(db)).toBe(false);
});

test("020 on a seeded database keeps a value the operator already set", async () => {
  const db = await dbAt(19);
  unwrap(await seedSpine(db, 19));
  unwrap(
    await seedRows(db, {
      settings: [{ key: KEY, value_json: "true", updated_at: 0 }],
    }),
  );
  unwrap(await migrateUp(db, { to: 20 }));
  expect(await parity(db)).toBe(true);
});

test("020 down removes the setting and nothing else; up again reseeds it", async () => {
  const db = await dbAt(20);
  unwrap(await seedSpine(db, 20));
  const others = unwrap(await getSettings(db, OTHERS));
  unwrap(await migrateDown(db));
  expect(unwrap(await migrationStatus(db)).applied.at(-1)?.version).toBe(19);
  expect(await parity(db)).toBeUndefined();
  expect(unwrap(await getSettings(db, OTHERS))).toEqual(others);
  unwrap(await migrateUp(db, { to: 20 }));
  expect(await parity(db)).toBe(false);
});
