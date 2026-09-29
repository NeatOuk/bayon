import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, unwrap } from "./testing.js";

// 033_jira_source: workspaces.jira_url/jira_email/jira_jql, set together or not at all,
// and the timer's seeded `jira.sync_interval_ms`, on an empty database and on one that already holds
// projects, up and down. Every project comes up without a source; an operator's own interval stays.
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
const columnsOf = (db: Db) =>
  Columns.parse(
    rawOf(db)
      .prepare(
        "SELECT name, type, \"notnull\" FROM pragma_table_info('workspaces') ORDER BY cid",
      )
      .all(),
  );

const BEFORE = [
  "id",
  "name",
  "kind",
  "default_executor_id",
  "default_runner_id",
  "paused",
  "staff_approval",
];
const KEY = "jira.sync_interval_ms";

const Setting = z.array(z.object({ value_json: z.string() }));
const intervalOf = (db: Db): string | undefined =>
  Setting.parse(
    rawOf(db).prepare("SELECT value_json FROM settings WHERE key = ?").all(KEY),
  )[0]?.value_json;

const insert = (
  db: Db,
  id: string,
  url: unknown,
  email: unknown,
  jql: unknown,
) =>
  rawOf(db)
    .prepare(
      "INSERT INTO workspaces (id, name, kind, jira_url, jira_email, jira_jql) VALUES (?, ?, 'single', ?, ?, ?)",
    )
    .run(id, id, url, email, jql);

test("033 on an empty database adds the three columns, all or none, and seeds the interval; down removes both", async () => {
  const db = await dbAt(32);
  expect(columnsOf(db).map((c) => c.name)).toEqual(BEFORE);
  expect(intervalOf(db)).toBeUndefined();

  unwrap(await migrateUp(db, { to: 33 }));
  expect(await version(db)).toBe(33);
  expect(columnsOf(db).slice(BEFORE.length)).toEqual([
    { name: "jira_url", type: "TEXT", notnull: 0 },
    { name: "jira_email", type: "TEXT", notnull: 0 },
    { name: "jira_jql", type: "TEXT", notnull: 0 },
  ]);
  expect(intervalOf(db)).toBe("900000");

  insert(
    db,
    "P-A",
    "https://acme.atlassian.net",
    "op@acme.test",
    "project = A",
  );
  insert(db, "P-B", null, null, null);
  const partial: readonly (readonly [unknown, unknown, unknown])[] = [
    ["https://acme.atlassian.net", null, null],
    [null, "op@acme.test", null],
    [null, null, "project = A"],
    ["https://acme.atlassian.net", "op@acme.test", null],
  ];
  for (const [i, [url, email, jql]] of partial.entries()) {
    expect(() => insert(db, `P-X${i}`, url, email, jql), String(i)).toThrow(
      /CHECK constraint/,
    );
  }

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(32);
  expect(columnsOf(db).map((c) => c.name)).toEqual(BEFORE);
  expect(intervalOf(db)).toBeUndefined();

  unwrap(await migrateUp(db, { to: 33 }));
  expect(intervalOf(db)).toBe("900000");
});

test("033 on a database holding projects keeps every row, none mirroring, and an interval already set", async () => {
  const db = await dbAt(32);
  unwrap(
    await seedRows(db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single", staff_approval: 1 },
        { id: "P-B", name: "P-B", kind: "multi", paused: 1 },
      ],
    }),
  );
  rawOf(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, '0', 1)",
    )
    .run(KEY);
  const rows = (columns: readonly string[]): unknown =>
    rawOf(db)
      .prepare(`SELECT ${columns.join(", ")} FROM workspaces ORDER BY id`)
      .all();
  const before = rows(BEFORE);

  unwrap(await migrateUp(db, { to: 33 }));
  expect(rows(BEFORE)).toEqual(before);
  expect(rows(["id", "jira_url", "jira_email", "jira_jql"])).toEqual([
    { id: "P-A", jira_url: null, jira_email: null, jira_jql: null },
    { id: "P-B", jira_url: null, jira_email: null, jira_jql: null },
  ]);
  expect(intervalOf(db)).toBe("0");

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(32);
  expect(rows(BEFORE)).toEqual(before);
});
