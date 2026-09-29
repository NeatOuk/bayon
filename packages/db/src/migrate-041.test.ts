import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, unwrap } from "./testing.js";

// 041_jira_push (M8.4): two workspace columns, the outbox and its watermarks, on an empty
// database and on one already holding projects and tickets, up, down and up again. Every project
// comes up moving nothing (no status map) and commenting pull requests (the default).
const V = 41;
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

const tables = (db: Db): unknown =>
  rawOf(db)
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'jira_push%' ORDER BY name",
    )
    .all();

const workspaceColumns = (db: Db): string[] =>
  rawOf(db)
    .prepare("SELECT name FROM pragma_table_info('workspaces') ORDER BY cid")
    .all()
    .map((r) => (r as { name: string }).name);

const insertPush = (db: Db, key: string, over: Record<string, unknown> = {}) =>
  rawOf(db)
    .prepare(
      `INSERT INTO jira_pushes (id, ticket_id, workspace_id, issue_key, kind, moment, payload_json, dedupe_key, state, created_at)
       VALUES (@id, 'T1', 'P1', 'ABC-1', @kind, 'started', @payload, @key, @state, 1)`,
    )
    .run({
      id: key,
      key,
      kind: "transition",
      payload: '{"status":"In Progress"}',
      state: "pending",
      ...over,
    });

async function seeded(): Promise<Db> {
  const db = await dbAt(V - 1);
  unwrap(
    await seedRows(db, {
      workspaces: [{ id: "P1", name: "P1", kind: "single" }],
    }),
  );
  rawOf(db)
    .prepare(
      "INSERT INTO tickets (id, num, title, type, status, origin, created_at, updated_at) VALUES ('T1', 1, 't', 'chore', 'backlog', 'jira', 1, 1)",
    )
    .run();
  return db;
}

test("041 on an empty database adds the columns and tables; down removes them; up again", async () => {
  const db = await dbAt(V - 1);
  const before = workspaceColumns(db);
  expect(tables(db)).toEqual([]);

  unwrap(await migrateUp(db, { to: V }));
  expect(await version(db)).toBe(V);
  expect(workspaceColumns(db).slice(before.length)).toEqual([
    "jira_status_map_json",
    "jira_comment_prs",
  ]);
  expect(tables(db)).toEqual([
    { name: "jira_push_cursors" },
    { name: "jira_pushes" },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(V - 1);
  expect(workspaceColumns(db)).toEqual(before);
  expect(tables(db)).toEqual([]);

  unwrap(await migrateUp(db, { to: V }));
  expect(tables(db)).toHaveLength(2);
});

test("041 on a seeded database: projects move nothing and comment PRs; the CHECKs hold", async () => {
  const db = await seeded();
  unwrap(await migrateUp(db, { to: V }));
  expect(
    rawOf(db)
      .prepare(
        "SELECT id, jira_status_map_json, jira_comment_prs FROM workspaces",
      )
      .all(),
  ).toEqual([{ id: "P1", jira_status_map_json: null, jira_comment_prs: 1 }]);

  const set = (col: string, value: unknown) => () =>
    rawOf(db)
      .prepare(`UPDATE workspaces SET ${col} = ? WHERE id = 'P1'`)
      .run(value);
  expect(set("jira_comment_prs", 2)).toThrow(/CHECK/);
  expect(set("jira_status_map_json", "{not json")).toThrow(/CHECK/);
  set("jira_status_map_json", '{"started":"In Progress"}')();

  insertPush(db, "k1");
  // The dedupe key is unique: a second filing of one moment is refused at the table.
  expect(() => insertPush(db, "k1")).toThrow(/UNIQUE|PRIMARY/);
  expect(() => insertPush(db, "k2", { kind: "email" })).toThrow(/CHECK/);
  expect(() => insertPush(db, "k3", { state: "lost" })).toThrow(/CHECK/);
  expect(() => insertPush(db, "k4", { payload: "nope" })).toThrow(/CHECK/);

  unwrap(await migrateDown(db));
  expect(rawOf(db).prepare("SELECT id, status FROM tickets").all()).toEqual([
    { id: "T1", status: "backlog" },
  ]);
  expect(tables(db)).toEqual([]);
  unwrap(await migrateUp(db, { to: V }));
  expect(
    rawOf(db).prepare("SELECT jira_comment_prs FROM workspaces").all(),
  ).toEqual([{ jira_comment_prs: 1 }]);
});
