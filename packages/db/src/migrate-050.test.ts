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

// 050_model_standby: models gains standby (0 | 1, default 0). On an empty and on a seeded
// database: every existing row is not on standby, nothing else changes, and down is 049's models
// table byte for byte.
const THIS = 50;
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

test("050 on an empty database: standby, 0 or 1; down is 049's text; up again", async () => {
  const db = await dbAt(THIS - 1);
  const before = schemaText(db);
  expect(columns(db)).not.toContain("standby");

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(columns(db).at(-1)).toBe("standby");
  unwrap(await seedSpine(db, THIS));
  const insert = (id: string, standby: number | null) =>
    raw(db)
      .prepare(
        `INSERT INTO models (id, runner_id, tier, model, active, standby)
         VALUES (?, ?, 'complex', 'm', 0, ?)`,
      )
      .run(id, SPINE_SEED.runnerId, standby);
  insert("on-standby", 1);
  expect(() => insert("bad-standby", 2)).toThrow(/CHECK/);
  expect(() => insert("null-standby", null)).toThrow(/NOT NULL/);
  raw(db)
    .prepare(
      `INSERT INTO models (id, runner_id, tier, model, active)
       VALUES ('defaulted', ?, 'cheap', 'm', 0)`,
    )
    .run(SPINE_SEED.runnerId);
  expect(
    raw(db).prepare("SELECT id, standby FROM models ORDER BY id").all(),
  ).toEqual([
    { id: "defaulted", standby: 0 },
    { id: "on-standby", standby: 1 },
  ]);
  raw(db)
    .prepare("DELETE FROM models WHERE id IN ('defaulted', 'on-standby')")
    .run();

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(schemaText(db)).toEqual(before);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
});

test("050 on a seeded database: every row is not on standby; the rest is untouched; down keeps the rows", async () => {
  const db = await dbAt(THIS - 1);
  unwrap(await seedSpine(db, THIS - 1));
  const { runnerId } = SPINE_SEED;
  unwrap(
    await seedRows(db, {
      models: [
        modelRow(runnerId, "complex", { context_tokens: 1_000_000 }),
        modelRow(runnerId, "cheap", { active: 0, retired_at: 5 }),
        modelRow(runnerId, "standard", {
          id: `${runnerId}.mine`,
          source: "operator",
          settings_json: '{"k":1}',
        }),
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
    modelsBefore.map((row) => ({ ...(row as object), standby: 0 })),
  );
  expect(await others(db)).toEqual(othersBefore);

  unwrap(await migrateDown(db));
  expect(raw(db).prepare("SELECT * FROM models ORDER BY id").all()).toEqual(
    modelsBefore,
  );
});
