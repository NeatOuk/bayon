import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, seedSpine, tempDb, ticketRow, unwrap } from "./testing.js";

// 031_project_timeline: audit_log.workspace_id with its backfill, and the four indexes a
// project's timeline and an agent's session list read through, on an empty database and on one that
// already holds audit rows, up and down. (repos/audit-scope.test.ts checks the backfill against the
// TypeScript resolver case by case.)
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

const Names = z.array(z.object({ name: z.string() }));
const columnsOf = (db: Db, table: string): string[] =>
  Names.parse(
    rawOf(db).prepare("SELECT name FROM pragma_table_info(?)").all(table),
  ).map((c) => c.name);
const indexNames = (db: Db): string[] =>
  Names.parse(
    rawOf(db)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all(),
  ).map((r) => r.name);

/** Each index, and a read of the shape it serves. */
const READS = {
  audit_log_workspace_ts_idx:
    "SELECT id FROM audit_log WHERE workspace_id = 'P' ORDER BY ts DESC, id DESC LIMIT 5",
  ticket_events_ts_idx:
    "SELECT id FROM ticket_events WHERE ts <= 9 ORDER BY ts DESC, id DESC LIMIT 5",
  sessions_agent_created_idx:
    "SELECT id FROM sessions WHERE agent_id = 'a' ORDER BY created_at DESC LIMIT 5",
  human_requests_session_idx:
    "SELECT id FROM human_requests WHERE session_id = 's'",
} as const;
const INDEXES = Object.keys(READS);

const Plan = z.array(z.object({ detail: z.string() }));
const planOf = (db: Db, query: string): string =>
  Plan.parse(rawOf(db).prepare(`EXPLAIN QUERY PLAN ${query}`).all())
    .map((r) => r.detail)
    .join(" · ");

test("031 on an empty database adds the column and the indexes each read uses; down removes them", async () => {
  const db = await dbAt(30);
  const auditBefore = columnsOf(db, "audit_log");
  expect(auditBefore).not.toContain("workspace_id");
  for (const name of INDEXES) expect(indexNames(db)).not.toContain(name);

  unwrap(await migrateUp(db, { to: 31 }));
  expect(await version(db)).toBe(31);
  expect(columnsOf(db, "audit_log")).toEqual([...auditBefore, "workspace_id"]);
  for (const [name, query] of Object.entries(READS)) {
    expect(planOf(db, query), name).toContain(name);
  }

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(30);
  expect(columnsOf(db, "audit_log")).toEqual(auditBefore);
  for (const name of INDEXES) expect(indexNames(db)).not.toContain(name);

  unwrap(await migrateUp(db, { to: 31 }));
  expect(indexNames(db)).toEqual(expect.arrayContaining(INDEXES));
});

test("031 on a database holding audit rows keeps every row and stamps the ones it can scope", async () => {
  const db = await dbAt(30);
  unwrap(await seedSpine(db, 30));
  unwrap(
    await seedRows(db, {
      workspaces: [{ id: "P", name: "P", kind: "single" }],
      tickets: [ticketRow(1, { workspace_id: "P" })],
      audit_log: [
        {
          ts: 1,
          actor: "operator",
          action: "ticket.update",
          target_kind: "ticket",
          target_id: "ticket-1",
          payload_json: "{}",
        },
        {
          ts: 2,
          actor: "operator",
          action: "settings.put",
          target_kind: "setting",
          target_id: "x",
        },
        {
          ts: 3,
          actor: "operator",
          action: "project.pause",
          target_kind: "project",
          target_id: "P",
          ip: "127.0.0.1",
        },
      ],
    }),
  );
  const auditColumns = columnsOf(db, "audit_log");
  const rows = (columns: readonly string[]): unknown =>
    rawOf(db)
      .prepare(`SELECT ${columns.join(", ")} FROM audit_log ORDER BY id`)
      .all();
  const before = rows(auditColumns);

  unwrap(await migrateUp(db, { to: 31 }));
  expect(rows(auditColumns)).toEqual(before);
  expect(rows(["action", "workspace_id"])).toEqual([
    { action: "ticket.update", workspace_id: "P" },
    { action: "settings.put", workspace_id: null },
    { action: "project.pause", workspace_id: "P" },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(30);
  expect(columnsOf(db, "audit_log")).toEqual(auditColumns);
  expect(rows(auditColumns)).toEqual(before);
});
