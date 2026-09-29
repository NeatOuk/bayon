import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { dumpAllRows, seedRows, seedSpine, tempDb, unwrap } from "./testing.js";

// 048_step_tiers: workspaces gains plan_tier, build_tier and review_tier, each NULL
// (inherit) or a tier. On an empty and on a seeded database: every existing project inherits,
// nothing else changes, and down is 047's workspaces table byte for byte.
const THIS = 48;
const STEPS = ["plan_tier", "build_tier", "review_tier"] as const;
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

/** The workspaces table's and its indexes' stored text: what down must restore exactly. */
const schemaText = (db: Db): unknown[] =>
  raw(db)
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'workspaces' ORDER BY name",
    )
    .all();

const columns = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare("SELECT name FROM pragma_table_info('workspaces')")
        .pluck()
        .all(),
    );

const workspaces = (db: Db): unknown[] =>
  raw(db).prepare("SELECT * FROM workspaces ORDER BY id").all();

test("048 on an empty database: three nullable tier columns; down is 047's text; up again", async () => {
  const db = await dbAt(THIS - 1);
  const before = schemaText(db);
  expect(columns(db)).not.toContain("plan_tier");

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(columns(db).slice(-3)).toEqual([...STEPS]);
  const insert = (id: string, column: string, tier: string | null) =>
    raw(db)
      .prepare(
        `INSERT INTO workspaces (id, name, kind, ${column}) VALUES (?, ?, 'single', ?)`,
      )
      .run(id, id, tier);
  insert("p-plan", "plan_tier", "complex");
  insert("p-build", "build_tier", "standard");
  insert("p-review", "review_tier", "cheap");
  insert("p-inherit", "plan_tier", null);
  for (const column of STEPS) {
    expect(() => insert(`bad-${column}`, column, "huge"), column).toThrow(
      /CHECK/,
    );
  }
  expect(
    raw(db)
      .prepare(
        "SELECT id, plan_tier, build_tier, review_tier FROM workspaces ORDER BY id",
      )
      .all(),
  ).toEqual([
    {
      id: "p-build",
      plan_tier: null,
      build_tier: "standard",
      review_tier: null,
    },
    { id: "p-inherit", plan_tier: null, build_tier: null, review_tier: null },
    { id: "p-plan", plan_tier: "complex", build_tier: null, review_tier: null },
    { id: "p-review", plan_tier: null, build_tier: null, review_tier: "cheap" },
  ]);
  raw(db).prepare("DELETE FROM workspaces").run();

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(schemaText(db)).toEqual(before);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
});

test("048 on a seeded database: every project inherits; the rest is untouched; down keeps the rows", async () => {
  const db = await dbAt(THIS - 1);
  unwrap(await seedSpine(db, THIS - 1));
  unwrap(
    await seedRows(db, {
      workspaces: [
        { id: "ws-a", name: "a", kind: "single", paused: 1 },
        {
          id: "ws-b",
          name: "b",
          kind: "multi",
          delivery_mode: "push",
          staff_approval: 1,
        },
      ],
    }),
  );
  const workspacesBefore = workspaces(db);
  const others = (d: Db) =>
    dumpAllRows(d).then((rows) =>
      Object.entries(unwrap(rows)).filter(
        ([table]) => !["workspaces", "_migrations"].includes(table),
      ),
    );
  const othersBefore = await others(db);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(workspaces(db)).toEqual(
    workspacesBefore.map((row) => ({
      ...(row as object),
      plan_tier: null,
      build_tier: null,
      review_tier: null,
    })),
  );
  expect(await others(db)).toEqual(othersBefore);

  raw(db).prepare("UPDATE workspaces SET plan_tier = 'complex'").run();
  unwrap(await migrateDown(db));
  expect(workspaces(db)).toEqual(workspacesBefore);
});
