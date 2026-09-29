import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import {
  SPINE_SEED,
  dumpAllRows,
  modelRow,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "./testing.js";

// 046_operator_models: models gains source ('adapter' | 'operator', default 'adapter')
// and settings_json (default '{}'). On an empty and on a seeded database: every existing row is an
// adapter's with no settings, nothing else changes, and down is 045's models table byte for byte.
const THIS = 46;
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

/** The models table's and its indexes' stored text: what down must restore exactly. */
const schemaText = (db: Db): unknown[] =>
  raw(db)
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'models' ORDER BY name",
    )
    .all();

const columns = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare("SELECT name FROM pragma_table_info('models')")
        .pluck()
        .all(),
    );

test("046 on an empty database: source and settings_json; down is 045's text; up again", async () => {
  const db = await dbAt(THIS - 1);
  const before = schemaText(db);
  expect(columns(db)).not.toContain("source");

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(columns(db).slice(-2)).toEqual(["source", "settings_json"]);
  unwrap(await seedSpine(db, THIS));
  const insert = (id: string, source: string) =>
    raw(db)
      .prepare(
        `INSERT INTO models (id, runner_id, tier, model, active, source)
         VALUES (?, ?, 'cheap', 'm', 0, ?)`,
      )
      .run(id, SPINE_SEED.runnerId, source);
  insert("ok-operator", "operator");
  expect(() => insert("bad-source", "someone")).toThrow(/CHECK/);
  expect(
    raw(db)
      .prepare(
        "SELECT source, settings_json FROM models WHERE id = 'ok-operator'",
      )
      .get(),
  ).toEqual({ source: "operator", settings_json: "{}" });
  raw(db).prepare("DELETE FROM models WHERE id = 'ok-operator'").run();

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(schemaText(db)).toEqual(before);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
});

test("046 on a seeded database: every row is an adapter's with no settings; the rest is untouched; down keeps the rows", async () => {
  const db = await dbAt(THIS - 1);
  unwrap(await seedSpine(db, THIS - 1));
  const { runnerId } = SPINE_SEED;
  unwrap(
    await seedRows(db, {
      models: [
        modelRow(runnerId, "complex", { context_tokens: 200_000 }),
        modelRow(runnerId, "cheap", { active: 0, retired_at: 5 }),
      ],
    }),
  );
  const modelsBefore = raw(db)
    .prepare("SELECT * FROM models ORDER BY id")
    .all();
  const others = (d: Db) =>
    dumpAllRows(d).then((rows) =>
      Object.entries(unwrap(rows)).filter(
        ([table]) => !["models", "_migrations"].includes(table),
      ),
    );
  const othersBefore = await others(db);

  unwrap(await migrateUp(db, { to: THIS }));
  const after = raw(db).prepare("SELECT * FROM models ORDER BY id").all();
  expect(after).toEqual(
    modelsBefore.map((row) => ({
      ...(row as object),
      source: "adapter",
      settings_json: "{}",
    })),
  );
  expect(await others(db)).toEqual(othersBefore);

  unwrap(await migrateDown(db));
  expect(raw(db).prepare("SELECT * FROM models ORDER BY id").all()).toEqual(
    modelsBefore,
  );
});
