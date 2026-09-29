import { DELIVERY_ROW_STATES, FakeClock, QA_RUN_STATES } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf } from "./connection.js";
import { migrationStatus } from "./migrate.js";
import { COLUMNS } from "./schema-columns.js";
import { tempDb, unwrap } from "./testing.js";

const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));

const TableInfo = z.array(
  z.object({
    name: z.string(),
    type: z.string(),
    notnull: z.int(),
    pk: z.int(),
  }),
);
const tableInfo = (table: string) =>
  TableInfo.parse(raw.pragma(`table_info(${table})`));

test("the column map covers exactly the migrated tables and views", async () => {
  const status = unwrap(await migrationStatus(t.db));
  expect(Object.keys(COLUMNS).toSorted()).toEqual(
    [...status.tables, ...status.views].toSorted(),
  );
});

// FTS5 tables (003) report columns without a declared type, like a view: names only for both.
const virtualTables = z
  .array(z.object({ name: z.string() }))
  .parse(
    raw
      .prepare("SELECT name FROM pragma_table_list WHERE type = 'virtual'")
      .all(),
  )
  .map((row) => row.name);

test("the column map equals PRAGMA table_info: name, type, nullability, primary key", async () => {
  const { views } = unwrap(await migrationStatus(t.db));
  expect(virtualTables.toSorted()).toEqual([
    "handoffs_fts",
    "knowledge_fts",
    "tickets_fts",
  ]);
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const info = tableInfo(table);
    if (views.includes(table) || virtualTables.includes(table)) {
      expect(
        info.map((c) => c.name),
        table,
      ).toEqual(Object.keys(columns));
      continue;
    }
    // A TEXT PRIMARY KEY reports notnull=0 (a SQLite quirk); the repositories always set it.
    const actual = info.map((c) => [
      c.name,
      { type: c.type, notnull: c.notnull === 1 || c.pk > 0, pk: c.pk },
    ]);
    const declared = Object.entries(columns).map(([name, spec]) => [
      name,
      { type: spec.type, notnull: spec.notnull, pk: spec.pk ?? 0 },
    ]);
    expect(Object.fromEntries(actual), table).toEqual(
      Object.fromEntries(declared),
    );
  }
});

/** The values a table's `CHECK (<column> IN (...))` takes, as the migrated schema declares them. */
function checkedValues(table: string, column: string): string[] {
  const { sql } = z
    .object({ sql: z.string() })
    .parse(
      raw
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table),
    );
  const list = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(
    sql,
  )?.[1];
  return (list ?? "").split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

// Core names these lists so the GUI's status map is typed from them; the schema is what
// they must agree with.
test("core's qa_runs and deliveries state lists are the schema's CHECKs", () => {
  expect(checkedValues("qa_runs", "state")).toEqual([...QA_RUN_STATES]);
  expect(checkedValues("deliveries", "state")).toEqual([
    ...DELIVERY_ROW_STATES,
  ]);
});
