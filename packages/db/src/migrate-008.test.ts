import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import type { Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { getSettings } from "./repos/config.js";
import { seedRows, seedSpine, tempDb, unwrap } from "./testing.js";

// 008_gate_retries: the retry budget decideGate reads, seeded as a setting.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const KEY = "gates.timeout_retries";

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const retries = async (db: Db) => unwrap(await getSettings(db, [KEY])).get(KEY);

test("008 on an empty database seeds gates.timeout_retries = 1", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 8 }));
  expect(await retries(db)).toBe(1);
});

test("008 on a seeded database keeps a value the operator already set", async () => {
  const db = await dbAt(7);
  unwrap(await seedSpine(db, 7));
  unwrap(
    await seedRows(db, {
      settings: [{ key: KEY, value_json: "3", updated_at: 0 }],
    }),
  );
  unwrap(await migrateUp(db, { to: 8 }));
  expect(await retries(db)).toBe(3);
});

test("008 down removes the setting and nothing else; up again reseeds it", async () => {
  const db = await dbAt(8);
  unwrap(await seedSpine(db, 8));
  const others = unwrap(
    await getSettings(db, ["gates.wall_clock_ms", "gates.base_drift"]),
  );
  unwrap(await migrateDown(db));
  expect(unwrap(await migrationStatus(db)).applied.at(-1)?.version).toBe(7);
  expect(await retries(db)).toBeUndefined();
  expect(
    unwrap(await getSettings(db, ["gates.wall_clock_ms", "gates.base_drift"])),
  ).toEqual(others);
  unwrap(await migrateUp(db, { to: 8 }));
  expect(await retries(db)).toBe(1);
});
