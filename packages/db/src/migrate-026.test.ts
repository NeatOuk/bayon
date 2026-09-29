import { FakeClock, LOGIN_IN_PLACE_KEY, LoginInPlace } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { tempDb, unwrap } from "./testing.js";

// 026_login_in_place: the consent row for a login used in place (§14), on an empty
// database and on one where an operator has already granted a runner its login, up and down.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;

const Row = z.object({ value_json: z.string() }).optional();
const grantsOf = (db: Db): string | undefined =>
  Row.parse(
    rawOf(db)
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(LOGIN_IN_PLACE_KEY),
  )?.value_json;

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

test("026 on an empty database seeds consent granted to nobody; down removes it", async () => {
  const db = await dbAt(25);
  expect(grantsOf(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: 26 }));
  expect(await version(db)).toBe(26);
  const value = grantsOf(db);
  expect(value).toBe("{}");
  // Off is what core reads from it: no runner, no path, nothing read.
  expect(LoginInPlace.parse(JSON.parse(value ?? "null"))).toEqual({});
  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(25);
  expect(grantsOf(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: 26 }));
  expect(grantsOf(db)).toBe("{}");
});

test("026 on a seeded database keeps an operator's own grants and the other settings", async () => {
  const db = await dbAt(25);
  const own = '{"a-runner":"/home/op/.a/auth.json"}';
  rawOf(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, 1)",
    )
    .run(LOGIN_IN_PLACE_KEY, own);
  const count = (): unknown =>
    rawOf(db).prepare("SELECT count(*) AS n FROM settings").get();
  const before = count();
  unwrap(await migrateUp(db, { to: 26 }));
  expect(grantsOf(db)).toBe(own);
  expect(count()).toEqual(before);
  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(25);
  expect(grantsOf(db)).toBeUndefined();
});
