import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, ticketRow, unwrap } from "./testing.js";

// 030_staff_approval: workspaces.staff_approval, human_requests.proposal_json and the
// (ticket_id, status) index, on an empty database and on one that already holds projects and
// requests, up and down. Every project comes up without approval, every request without a proposal,
// and a ticket's open requests are read through the index.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const INDEX = "human_requests_ticket_status_idx";

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
const columnsOf = (db: Db, table: string) =>
  Columns.parse(
    rawOf(db)
      .prepare(
        'SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?) ORDER BY cid',
      )
      .all(table),
  );
const namesOf = (db: Db, table: string): string[] =>
  columnsOf(db, table).map((c) => c.name);

const Names = z.array(z.object({ name: z.string() }));
const indexNames = (db: Db): string[] =>
  Names.parse(
    rawOf(db)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all(),
  ).map((r) => r.name);

/** A ticket's open requests: the shape of the pulse filter's correlated lookup. */
const OPEN_ON_TICKET =
  "SELECT id FROM human_requests WHERE ticket_id = ? AND status = 'open'";
const Plan = z.array(z.object({ detail: z.string() }));
const planOf = (db: Db): string =>
  Plan.parse(
    rawOf(db).prepare(`EXPLAIN QUERY PLAN ${OPEN_ON_TICKET}`).all("ticket-1"),
  )
    .map((r) => r.detail)
    .join(" · ");

const WORKSPACES_BEFORE = [
  "id",
  "name",
  "kind",
  "default_executor_id",
  "default_runner_id",
  "paused",
];

test("030 on an empty database adds the switch, the proposal column and the index; down removes them", async () => {
  const db = await dbAt(29);
  expect(namesOf(db, "workspaces")).toEqual(WORKSPACES_BEFORE);
  const requestsBefore = namesOf(db, "human_requests");
  expect(requestsBefore).not.toContain("proposal_json");
  expect(planOf(db)).not.toContain(INDEX);

  unwrap(await migrateUp(db, { to: 30 }));
  expect(await version(db)).toBe(30);
  expect(columnsOf(db, "workspaces").at(-1)).toEqual({
    name: "staff_approval",
    type: "INTEGER",
    notnull: 1,
    dflt_value: "0",
  });
  expect(columnsOf(db, "human_requests").at(-1)).toEqual({
    name: "proposal_json",
    type: "TEXT",
    notnull: 0,
    dflt_value: null,
  });
  expect(indexNames(db)).toContain(INDEX);
  expect(planOf(db)).toContain(INDEX);
  const insert = (id: string, value: number) =>
    rawOf(db)
      .prepare(
        "INSERT INTO workspaces (id, name, kind, staff_approval) VALUES (?, ?, 'single', ?)",
      )
      .run(id, id, value);
  insert("P-A", 1);
  expect(() => insert("P-B", 2)).toThrow(/CHECK constraint/);
  expect(() =>
    rawOf(db).prepare("UPDATE workspaces SET staff_approval = NULL").run(),
  ).toThrow(/NOT NULL/);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(29);
  expect(namesOf(db, "workspaces")).toEqual(WORKSPACES_BEFORE);
  expect(namesOf(db, "human_requests")).toEqual(requestsBefore);
  expect(indexNames(db)).not.toContain(INDEX);

  unwrap(await migrateUp(db, { to: 30 }));
  expect(indexNames(db)).toContain(INDEX);
});

test("030 on a database holding projects and requests keeps every row, none approving or proposing", async () => {
  const db = await dbAt(29);
  unwrap(
    await seedRows(db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "multi", paused: 1 },
      ],
      tickets: [ticketRow(1, { status: "prioritized", workspace_id: "P-A" })],
      human_requests: [
        {
          id: "R-1",
          ticket_id: "ticket-1",
          kind: "decision",
          question: "which way?",
          asked_at: 1,
        },
        {
          id: "R-2",
          kind: "circuit_breaker",
          question: "stop?",
          asked_at: 2,
          status: "answered",
          dedupe_key: "circuit:x:1",
        },
      ],
    }),
  );
  const rows = (table: string, columns: readonly string[]): unknown =>
    rawOf(db)
      .prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`)
      .all();
  const requestColumns = namesOf(db, "human_requests");
  const before = {
    workspaces: rows("workspaces", WORKSPACES_BEFORE),
    requests: rows("human_requests", requestColumns),
  };

  unwrap(await migrateUp(db, { to: 30 }));
  expect(rows("workspaces", WORKSPACES_BEFORE)).toEqual(before.workspaces);
  expect(rows("human_requests", requestColumns)).toEqual(before.requests);
  expect(rows("workspaces", ["id", "staff_approval"])).toEqual([
    { id: "P-A", staff_approval: 0 },
    { id: "P-B", staff_approval: 0 },
  ]);
  expect(rows("human_requests", ["id", "proposal_json"])).toEqual([
    { id: "R-1", proposal_json: null },
    { id: "R-2", proposal_json: null },
  ]);
  expect(rawOf(db).prepare(OPEN_ON_TICKET).all("ticket-1")).toEqual([
    { id: "R-1" },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(29);
  expect(rows("workspaces", WORKSPACES_BEFORE)).toEqual(before.workspaces);
  expect(rows("human_requests", requestColumns)).toEqual(before.requests);
});
