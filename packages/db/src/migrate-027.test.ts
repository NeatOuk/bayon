import { FakeClock, LOCAL_ROOTS_KEY, LocalRoots } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { tempDb, unwrap } from "./testing.js";

// 027_project_local_roots: the folders POST /projects may take a path from (§14), on
// an empty database and on one where an operator has already allowed a folder, up and down.
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
const rootsOf = (db: Db): string | undefined =>
  Row.parse(
    rawOf(db)
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(LOCAL_ROOTS_KEY),
  )?.value_json;

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

test("027 on an empty database seeds no folder; down removes it", async () => {
  const db = await dbAt(26);
  expect(rootsOf(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: 27 }));
  expect(await version(db)).toBe(27);
  const value = rootsOf(db);
  expect(value).toBe("[]");
  expect(LocalRoots.parse(JSON.parse(value ?? "null"))).toEqual([]);
  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(26);
  expect(rootsOf(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: 27 }));
  expect(rootsOf(db)).toBe("[]");
});

test("027 on a seeded database keeps an operator's own folders and the other settings", async () => {
  const db = await dbAt(26);
  const own = '["/home/op/src"]';
  rawOf(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, 1)",
    )
    .run(LOCAL_ROOTS_KEY, own);
  const count = (): unknown =>
    rawOf(db).prepare("SELECT count(*) AS n FROM settings").get();
  const before = count();
  unwrap(await migrateUp(db, { to: 27 }));
  expect(rootsOf(db)).toBe(own);
  expect(count()).toEqual(before);
  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(26);
  expect(rootsOf(db)).toBeUndefined();
});
