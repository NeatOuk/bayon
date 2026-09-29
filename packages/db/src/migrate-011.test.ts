import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import type { Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { getSettings } from "./repos/config.js";
import { seedRows, seedSpine, tempDb, unwrap } from "./testing.js";

// 011_gate_poll: the gate engine's poll interval, seeded as a setting.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const KEY = "gates.supersede_poll_ms";

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const poll = async (db: Db) => unwrap(await getSettings(db, [KEY])).get(KEY);

test("011 on an empty database seeds gates.supersede_poll_ms = 5000", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 11 }));
  expect(await poll(db)).toBe(5000);
});

test("011 on a seeded database keeps a value the operator already set", async () => {
  const db = await dbAt(10);
  unwrap(await seedSpine(db, 10));
  unwrap(
    await seedRows(db, {
      settings: [{ key: KEY, value_json: "2000", updated_at: 0 }],
    }),
  );
  unwrap(await migrateUp(db, { to: 11 }));
  expect(await poll(db)).toBe(2000);
});

test("011 down removes the setting and nothing else; up again reseeds it", async () => {
  const db = await dbAt(11);
  unwrap(await seedSpine(db, 11));
  const others = unwrap(
    await getSettings(db, ["gates.wall_clock_ms", "gates.timeout_retries"]),
  );
  unwrap(await migrateDown(db));
  expect(unwrap(await migrationStatus(db)).applied.at(-1)?.version).toBe(10);
  expect(await poll(db)).toBeUndefined();
  expect(
    unwrap(
      await getSettings(db, ["gates.wall_clock_ms", "gates.timeout_retries"]),
    ),
  ).toEqual(others);
  unwrap(await migrateUp(db, { to: 11 }));
  expect(await poll(db)).toBe(5000);
});
