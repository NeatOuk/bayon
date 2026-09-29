import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedSpine, tempDb, unwrap } from "./testing.js";

// 014_watchdog: human_requests.dedupe_key and its plain unique index, on an empty and on
// a seeded database, down and up again.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;

const Columns = z.array(z.object({ name: z.string() }));
const columnsOf = (db: Db): string[] =>
  Columns.parse(
    rawOf(db)
      .prepare(
        "SELECT name FROM pragma_table_info('human_requests') ORDER BY cid",
      )
      .all(),
  ).map((c) => c.name);

const Index = z.array(z.object({ name: z.string(), sql: z.string() }));
const dedupeIndex = (db: Db) =>
  Index.parse(
    rawOf(db)
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'human_requests_dedupe_idx'",
      )
      .all(),
  )[0];

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const insert = (db: Db, id: string, key: string | null) =>
  rawOf(db)
    .prepare(
      "INSERT INTO human_requests (id, kind, question, status, asked_at, dedupe_key) VALUES (?, 'question', 'q', 'open', 1, ?)",
    )
    .run(id, key);

test("014 on an empty database: the column and a plain unique index, and down removes both", async () => {
  const db = await dbAt(13);
  expect(columnsOf(db)).not.toContain("dedupe_key");
  unwrap(await migrateUp(db, { to: 14 }));
  expect(await version(db)).toBe(14);
  expect(columnsOf(db).at(-1)).toBe("dedupe_key");
  const index = dedupeIndex(db);
  expect(index?.sql).toMatch(/^CREATE UNIQUE INDEX/);
  // Plain, never partial: ON CONFLICT (dedupe_key) cannot target a partial index.
  expect(index?.sql).not.toMatch(/WHERE/i);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(13);
  expect(columnsOf(db)).not.toContain("dedupe_key");
  expect(dedupeIndex(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: 14 }));
  expect(await version(db)).toBe(14);
});

test("014 on a seeded database: human_ask rows keep a NULL key and coexist; a duplicate key conflicts", async () => {
  const db = await dbAt(13);
  unwrap(await seedSpine(db, 13));
  rawOf(db)
    .prepare(
      "INSERT INTO human_requests (id, kind, question, status, asked_at) VALUES ('H1', 'question', 'q', 'open', 1), ('H2', 'question', 'q', 'open', 1)",
    )
    .run();
  unwrap(await migrateUp(db, { to: 14 }));
  const Keys = z.array(z.object({ id: z.string(), dedupe_key: z.null() }));
  expect(
    Keys.parse(
      rawOf(db)
        .prepare("SELECT id, dedupe_key FROM human_requests ORDER BY id")
        .all(),
    ).map((r) => r.id),
  ).toEqual(["H1", "H2"]);
  // More NULL keys are fine: NULLs are distinct under a unique index.
  insert(db, "H3", null);
  insert(db, "S1", "circuit:T1:0");
  expect(() => insert(db, "S2", "circuit:T1:0")).toThrow(/UNIQUE/);
  const conflict = rawOf(db)
    .prepare(
      "INSERT INTO human_requests (id, kind, question, status, asked_at, dedupe_key) VALUES ('S3', 'x', 'q', 'open', 1, 'circuit:T1:0') ON CONFLICT (dedupe_key) DO NOTHING RETURNING id",
    )
    .all();
  expect(conflict).toEqual([]);

  unwrap(await migrateDown(db));
  expect(
    rawOf(db).prepare("SELECT COUNT(*) AS n FROM human_requests").get(),
  ).toEqual({ n: 4 });
});
