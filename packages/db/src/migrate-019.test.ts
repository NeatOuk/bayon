import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedSpine, tempDb, unwrap } from "./testing.js";

// 019_attention_acks: the table the operator's dismissal writes, on an empty database
// and on one that already holds sessions, up and down.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const TABLE = "attention_acks";

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const Tables = z.array(z.object({ name: z.string() }));
const tableNames = (db: Db): string[] =>
  Tables.parse(
    rawOf(db)
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all(),
  ).map((r) => r.name);

test("019 on an empty database adds attention_acks; down removes it", async () => {
  const db = await dbAt(18);
  expect(tableNames(db)).not.toContain(TABLE);

  unwrap(await migrateUp(db, { to: 19 }));
  expect(await version(db)).toBe(19);
  expect(tableNames(db)).toContain(TABLE);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(18);
  expect(tableNames(db)).not.toContain(TABLE);

  unwrap(await migrateUp(db, { to: 19 }));
  expect(tableNames(db)).toContain(TABLE);
});

test("019 on a database that already holds sessions keeps every row", async () => {
  const db = await dbAt(18);
  unwrap(await seedSpine(db, 18));
  const raw = rawOf(db);
  const Count = z.object({ n: z.number() });
  const sessions = (): number =>
    Count.parse(raw.prepare("SELECT count(*) AS n FROM sessions").get()).n;
  const before = sessions();
  expect(before).toBeGreaterThan(0);

  unwrap(await migrateUp(db, { to: 19 }));
  expect(sessions()).toBe(before);

  // The session's own ack goes with it: an acknowledgement of a row that no longer exists would
  // be a leak, and the strip is derived from sessions anyway.
  const seeded = z
    .object({ id: z.string() })
    .parse(raw.prepare("SELECT id FROM sessions LIMIT 1").get());
  raw
    .prepare(
      "INSERT INTO attention_acks (session_id, acked_at, acked_by) VALUES (?, ?, ?)",
    )
    .run(seeded.id, clock.now(), "operator");
  raw.prepare("PRAGMA foreign_keys = ON").run();
  raw.prepare("DELETE FROM sessions WHERE id = ?").run(seeded.id);
  expect(
    Count.parse(raw.prepare("SELECT count(*) AS n FROM attention_acks").get())
      .n,
  ).toBe(0);

  unwrap(await migrateDown(db));
  expect(sessions()).toBe(before - 1);
});
