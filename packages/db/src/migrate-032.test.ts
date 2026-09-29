import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { addSession, seedSpine, tempDb, unwrap } from "./testing.js";

// 032_attach_intent: sessions.attach_intent_owner and attach_intent_at, a pending "take
// over after this step", on an empty database and on one that already holds sessions, up and down.
// Every session there comes up with nothing pending, the two columns are set together or not at
// all, and down gives the table back with its rows.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const Columns = z.array(
  z.object({ name: z.string(), type: z.string(), notnull: z.int() }),
);
const sessionColumns = (db: Db) =>
  Columns.parse(
    rawOf(db)
      .prepare(
        "SELECT name, type, \"notnull\" FROM pragma_table_info('sessions') ORDER BY cid",
      )
      .all(),
  );
const names = (db: Db): string[] => sessionColumns(db).map((c) => c.name);

const Intent = z.array(
  z.object({
    id: z.string(),
    attach_intent_owner: z.string().nullable(),
    attach_intent_at: z.int().nullable(),
  }),
);
const intentsOf = (db: Db) =>
  Intent.parse(
    rawOf(db)
      .prepare(
        "SELECT id, attach_intent_owner, attach_intent_at FROM sessions ORDER BY id",
      )
      .all(),
  );

const setIntent = (db: Db, owner: string | null, at: number | null) =>
  rawOf(db)
    .prepare(
      "UPDATE sessions SET attach_intent_owner = ?, attach_intent_at = ?",
    )
    .run(owner, at);

test("032 on an empty database adds the two nullable columns, set together or not at all; down removes them", async () => {
  const db = await dbAt(31);
  const before = names(db);
  expect(before).not.toContain("attach_intent_owner");

  unwrap(await migrateUp(db, { to: 32 }));
  expect(await version(db)).toBe(32);
  expect(sessionColumns(db).slice(-2)).toEqual([
    { name: "attach_intent_owner", type: "TEXT", notnull: 0 },
    { name: "attach_intent_at", type: "INTEGER", notnull: 0 },
  ]);

  unwrap(await seedSpine(db, 2));
  unwrap(await addSession(db, "S-1"));
  expect(intentsOf(db).every((s) => s.attach_intent_at === null)).toBe(true);
  setIntent(db, "tab-1", 5);
  expect(intentsOf(db).map((s) => s.attach_intent_owner)).not.toContain(null);
  setIntent(db, null, null);
  // Half an intent is refused either way round.
  expect(() => setIntent(db, "tab-1", null)).toThrow(/CHECK constraint/);
  expect(() => setIntent(db, null, 5)).toThrow(/CHECK constraint/);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(31);
  expect(names(db)).toEqual(before);

  unwrap(await migrateUp(db, { to: 32 }));
  expect(names(db)).toEqual([
    ...before,
    "attach_intent_owner",
    "attach_intent_at",
  ]);
});

test("032 on a database holding sessions keeps every row, nothing pending; a pending ask goes with down", async () => {
  const db = await dbAt(31);
  unwrap(await seedSpine(db, 2));
  unwrap(await addSession(db, "S-1"));
  unwrap(await addSession(db, "S-2"));
  const before = names(db);
  const rows = (): unknown =>
    rawOf(db)
      .prepare(`SELECT ${before.join(", ")} FROM sessions ORDER BY id`)
      .all();
  const seeded = rows();

  unwrap(await migrateUp(db, { to: 32 }));
  expect(rows()).toEqual(seeded);
  expect(
    intentsOf(db).every(
      (s) => s.attach_intent_owner === null && s.attach_intent_at === null,
    ),
  ).toBe(true);
  setIntent(db, "tab-1", 5);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(31);
  expect(names(db)).toEqual(before);
  expect(rows()).toEqual(seeded);
});
