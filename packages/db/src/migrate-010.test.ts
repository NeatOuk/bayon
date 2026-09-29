import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "./testing.js";

// 010_executor_health_detail: executors.health_detail, the last health check's JSON.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const raw = (db: Db) => unwrap(internalsOf(db)).raw;
const columns = (db: Db): string[] =>
  raw(db)
    .prepare("SELECT name FROM pragma_table_info('executors') ORDER BY cid")
    .all()
    .map((row) => (row as { name: string }).name);
const executor = (db: Db) =>
  raw(db)
    .prepare("SELECT * FROM executors WHERE id = ?")
    .get(SPINE_SEED.executorId);

test("010 on an empty database adds executors.health_detail, NULL by default", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 10 }));
  expect(columns(db).at(-1)).toBe("health_detail");
  unwrap(await seedSpine(db, 10));
  expect(executor(db)).toMatchObject({
    health: "unknown",
    health_detail: null,
  });
});

test("010 on a seeded database keeps every executor row as it was", async () => {
  const db = await dbAt(9);
  unwrap(await seedSpine(db, 9));
  const before = executor(db);
  unwrap(await migrateUp(db, { to: 10 }));
  expect(executor(db)).toEqual({ ...(before as object), health_detail: null });
});

test("010 down drops the column and nothing else; up again restores it", async () => {
  const db = await dbAt(10);
  unwrap(await seedSpine(db, 10));
  raw(db)
    .prepare(
      "UPDATE executors SET health = 'healthy', health_detail = '{}' WHERE id = ?",
    )
    .run(SPINE_SEED.executorId);
  unwrap(await migrateDown(db));
  expect(unwrap(await migrationStatus(db)).applied.at(-1)?.version).toBe(9);
  expect(columns(db)).not.toContain("health_detail");
  expect(executor(db)).toMatchObject({ health: "healthy" });
  unwrap(await migrateUp(db, { to: 10 }));
  expect(executor(db)).toMatchObject({
    health: "healthy",
    health_detail: null,
  });
});
