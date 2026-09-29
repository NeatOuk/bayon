import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, unwrap } from "./testing.js";

// 029_project_paused: workspaces.paused, one project's own hold, on an empty database
// and on one that already holds projects, up and down. Every workspace there comes up unpaused, a
// value other than 0 or 1 is refused, and down gives the table back with its rows.
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
  z.object({
    name: z.string(),
    type: z.string(),
    notnull: z.int(),
    dflt_value: z.string().nullable(),
  }),
);
const columnsOf = (db: Db) =>
  Columns.parse(
    rawOf(db)
      .prepare(
        "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('workspaces') ORDER BY cid",
      )
      .all(),
  );
const columnNames = (db: Db): string[] => columnsOf(db).map((c) => c.name);

const BEFORE = [
  "id",
  "name",
  "kind",
  "default_executor_id",
  "default_runner_id",
];

const Paused = z.array(z.object({ id: z.string(), paused: z.int() }));
const pausedOf = (db: Db) =>
  Paused.parse(
    rawOf(db).prepare("SELECT id, paused FROM workspaces ORDER BY id").all(),
  );

const insertWorkspace = (db: Db, id: string, paused?: number) =>
  paused === undefined
    ? rawOf(db)
        .prepare(
          "INSERT INTO workspaces (id, name, kind) VALUES (?, ?, 'single')",
        )
        .run(id, id)
    : rawOf(db)
        .prepare(
          "INSERT INTO workspaces (id, name, kind, paused) VALUES (?, ?, 'single', ?)",
        )
        .run(id, id, paused);

test("029 on an empty database adds workspaces.paused, 0 by default, 0 or 1 only; down removes it", async () => {
  const db = await dbAt(28);
  expect(columnNames(db)).toEqual(BEFORE);

  unwrap(await migrateUp(db, { to: 29 }));
  expect(await version(db)).toBe(29);
  expect(columnsOf(db).at(-1)).toEqual({
    name: "paused",
    type: "INTEGER",
    notnull: 1,
    dflt_value: "0",
  });
  insertWorkspace(db, "P-A");
  insertWorkspace(db, "P-B", 1);
  expect(pausedOf(db)).toEqual([
    { id: "P-A", paused: 0 },
    { id: "P-B", paused: 1 },
  ]);
  expect(() => insertWorkspace(db, "P-C", 2)).toThrow(/CHECK constraint/);
  expect(() =>
    rawOf(db).prepare("UPDATE workspaces SET paused = NULL").run(),
  ).toThrow(/NOT NULL/);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(28);
  expect(columnNames(db)).toEqual(BEFORE);

  unwrap(await migrateUp(db, { to: 29 }));
  expect(columnNames(db)).toEqual([...BEFORE, "paused"]);
  // A paused project's pause went with the column: down, then up again, it is 0.
  expect(pausedOf(db)).toEqual([
    { id: "P-A", paused: 0 },
    { id: "P-B", paused: 0 },
  ]);
});

test("029 on a database holding projects keeps every row, each unpaused; down keeps them too", async () => {
  const db = await dbAt(28);
  unwrap(
    await seedRows(db, {
      executors: [{ id: "local", kind: "local", config_json: "{}" }],
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        {
          id: "P-B",
          name: "P-B",
          kind: "multi",
          default_executor_id: "local",
        },
      ],
    }),
  );
  const rows = (): unknown =>
    rawOf(db)
      .prepare(`SELECT ${BEFORE.join(", ")} FROM workspaces ORDER BY id`)
      .all();
  const before = rows();
  expect(before).toHaveLength(2);

  unwrap(await migrateUp(db, { to: 29 }));
  expect(rows()).toEqual(before);
  expect(pausedOf(db)).toEqual([
    { id: "P-A", paused: 0 },
    { id: "P-B", paused: 0 },
  ]);
  rawOf(db).prepare("UPDATE workspaces SET paused = 1 WHERE id = 'P-B'").run();

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(28);
  expect(columnNames(db)).toEqual(BEFORE);
  expect(rows()).toEqual(before);
});
