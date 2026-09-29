import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "./testing.js";

// 051_runner_updates: the runner update check's two tables and its setting, on an
// empty database and on one that already holds a runner, up and down.
const THIS = 51;
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

/** Every table's and index's stored text: what down must restore exactly (050's pattern). */
const schemaText = (db: Db): unknown[] =>
  raw(db)
    .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
    .all();

const Tables = z.array(z.object({ name: z.string() }));
const tableNames = (db: Db): string[] =>
  Tables.parse(
    raw(db).prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
  ).map((r) => r.name);

const Setting = z.object({ value_json: z.string() });
function settingValue(db: Db, key: string): string | undefined {
  const row = raw(db)
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(key);
  if (row === undefined) return undefined;
  return Setting.parse(row).value_json;
}

test("051 on an empty database: both tables, the setting, and their CHECKs; down removes them; up again", async () => {
  const db = await dbAt(THIS - 1);
  const before = schemaText(db);
  expect(tableNames(db)).not.toContain("runner_updates");
  expect(tableNames(db)).not.toContain("runner_update_dismissals");

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(tableNames(db)).toContain("runner_updates");
  expect(tableNames(db)).toContain("runner_update_dismissals");
  expect(settingValue(db, "runners.update_check_hours")).toBe("24");

  unwrap(await seedSpine(db, THIS));
  const { runnerId } = SPINE_SEED;
  const now = clock.now();
  const insertUpdate = (
    latest: string,
    newer: number,
    notesUrl: string | null,
  ) =>
    raw(db)
      .prepare(
        `INSERT INTO runner_updates (runner_id, latest, current, newer, notes_url, found_at, checked_at)
         VALUES (?, ?, '0.1.0', ?, ?, ?, ?)`,
      )
      .run(runnerId, latest, newer, notesUrl, now, now);
  insertUpdate("0.2.0", 1, "https://example.com/notes");
  expect(() => insertUpdate("bad-newer", 2, null)).toThrow(/CHECK/);
  expect(() => insertUpdate("bad-url", 1, "http://example.com")).toThrow(
    /CHECK/,
  );
  expect(() =>
    raw(db)
      .prepare(
        `INSERT INTO runner_updates (runner_id, latest, current, newer, found_at, checked_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(runnerId, "0.2.0", "x".repeat(65), now, now),
  ).toThrow(/CHECK/);
  expect(() =>
    raw(db)
      .prepare(
        `INSERT INTO runner_updates (runner_id, latest, current, newer, found_at, checked_at)
         VALUES ('no-such-runner', '0.2.0', '0.1.0', 1, ?, ?)`,
      )
      .run(now, now),
  ).toThrow(/FOREIGN KEY/);

  // A dismissal of a row that was never recorded is refused by the FK, not silently accepted.
  expect(() =>
    raw(db)
      .prepare(
        `INSERT INTO runner_update_dismissals (runner_id, latest, dismissed_at, dismissed_by)
         VALUES (?, 'never-seen', ?, 'operator')`,
      )
      .run(runnerId, now),
  ).toThrow(/FOREIGN KEY/);
  raw(db)
    .prepare(
      `INSERT INTO runner_update_dismissals (runner_id, latest, dismissed_at, dismissed_by)
       VALUES (?, '0.2.0', ?, 'operator')`,
    )
    .run(runnerId, now);
  // The dismissal cascades when its runner_updates row is deleted.
  raw(db)
    .prepare(
      "DELETE FROM runner_updates WHERE runner_id = ? AND latest = '0.2.0'",
    )
    .run(runnerId);
  expect(
    raw(db).prepare("SELECT count(*) AS n FROM runner_update_dismissals").get(),
  ).toEqual({ n: 0 });

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(tableNames(db)).not.toContain("runner_updates");
  expect(tableNames(db)).not.toContain("runner_update_dismissals");
  expect(settingValue(db, "runners.update_check_hours")).toBeUndefined();
  expect(schemaText(db)).toEqual(before);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
});

test("051 on a database with an operator-set value keeps it (INSERT OR IGNORE)", async () => {
  const db = await dbAt(THIS - 1);
  raw(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('runners.update_check_hours', '48', ?)",
    )
    .run(clock.now());

  unwrap(await migrateUp(db, { to: THIS }));
  expect(settingValue(db, "runners.update_check_hours")).toBe("48");

  unwrap(await migrateDown(db));
  expect(settingValue(db, "runners.update_check_hours")).toBeUndefined();
});
