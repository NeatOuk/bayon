import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { createSession } from "./repos/sessions.js";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "./testing.js";

// 003_work (FOR-11): the §4 work tables, their FTS (M1 amendment 3), the unique MCP token index,
// and v_needs_attention / v_ticket_economics (amendments 4 and 9).
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

/** The tables 003 adds, as migrationStatus lists them: by name, FTS shadow tables left out. */
const NEW_TABLES = [
  "approvals",
  "findings",
  "gates",
  "handoffs",
  "handoffs_fts",
  "human_requests",
  "knowledge",
  "knowledge_fts",
  "messages",
  "role_bindings",
  "ticket_events",
  "ticket_exports",
  "ticket_links",
  "ticket_repos",
  "tickets_fts",
];

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const exec = (db: Db, statement: string): void => {
  rawOf(db).prepare(statement).run();
};

const Nums = z.array(z.object({ num: z.int() }));
const Refs = z.array(z.object({ ref: z.string() }));

/** Nums of the tickets an FTS5 query matches, ascending. */
const ticketsMatching = (db: Db, query: string): number[] =>
  Nums.parse(
    rawOf(db)
      .prepare(
        "SELECT rowid AS num FROM tickets_fts WHERE tickets_fts MATCH ? ORDER BY rowid",
      )
      .all(query),
  ).map((row) => row.num);

/** Refs of the rows an own-copy FTS table matches, ascending. */
const refsMatching = (
  db: Db,
  table: "knowledge_fts" | "handoffs_fts",
  query: string,
): string[] =>
  Refs.parse(
    rawOf(db)
      .prepare(`SELECT ref FROM ${table} WHERE ${table} MATCH ? ORDER BY ref`)
      .all(query),
  ).map((row) => row.ref);

/** FTS5's integrity-check: throws if the index disagrees with the rows it indexes. */
const checkIndex = (db: Db, table: string): void =>
  exec(db, `INSERT INTO ${table} (${table}) VALUES ('integrity-check')`);

/** The schema in a fixed order, without rootpage. */
const dump = (db: Db): string =>
  JSON.stringify(
    rawOf(db)
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      )
      .all(),
  );

test("003 adds the work tables, their FTS tables and both views; FTS shadow tables stay out of status", async () => {
  const db = await dbAt(2);
  const before = unwrap(await migrationStatus(db));
  const after = unwrap(await migrateUp(db, { to: 3 }));
  expect(after.tables.filter((t) => !before.tables.includes(t))).toEqual(
    NEW_TABLES,
  );
  expect(after.views).toEqual([
    "v_fleet",
    "v_needs_attention",
    "v_ticket_economics",
  ]);
});

test("003 runs on a seeded 002 database and indexes the tickets already there (rebuild)", async () => {
  const db = await dbAt(2);
  unwrap(await seedSpine(db, 2));
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(1, { title: "Flaky login redirect" }),
        ticketRow(7, {
          title: "Export pipeline",
          body_md: "breaks the login page",
        }),
      ],
    }),
  );
  unwrap(await migrateUp(db, { to: 3 }));
  expect(ticketsMatching(db, "login")).toEqual([1, 7]);
  expect(ticketsMatching(db, "title:login")).toEqual([1]);
  expect(ticketsMatching(db, "pipeline")).toEqual([7]);
  checkIndex(db, "tickets_fts");
});

test("triggers keep tickets_fts in step with inserts, updates and deletes", async () => {
  const db = await dbAt(3);
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(1, { title: "alpha" }),
        ticketRow(2, { title: "beta" }),
      ],
    }),
  );
  expect(ticketsMatching(db, "alpha")).toEqual([1]);
  exec(db, "UPDATE tickets SET title = 'gamma' WHERE num = 1");
  expect(ticketsMatching(db, "alpha")).toEqual([]);
  expect(ticketsMatching(db, "gamma")).toEqual([1]);
  exec(db, "UPDATE tickets SET body_md = 'delta' WHERE num = 1");
  expect(ticketsMatching(db, "delta")).toEqual([1]);
  exec(db, "UPDATE tickets SET status = 'prioritized' WHERE num = 2");
  expect(ticketsMatching(db, "beta")).toEqual([2]);
  exec(db, "DELETE FROM tickets WHERE num = 2");
  expect(ticketsMatching(db, "beta")).toEqual([]);
  checkIndex(db, "tickets_fts");
});

test("knowledge_fts and handoffs_fts keep their own copy, keyed by ref", async () => {
  const db = await dbAt(3);
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(1)],
      knowledge: [
        {
          id: "K1",
          scope: "repo",
          kind: "trap",
          title: "WAL on NFS",
          body_md: "never put the database on a share",
          created_at: 0,
        },
      ],
      handoffs: [
        {
          id: "H1",
          ticket_id: "ticket-1",
          reason: "context_ceiling",
          facts_json: "{}",
          goal_line: "finish the exporter",
          next_steps_md: "wire the rebuild",
          packet_path: "/p/H1.md",
          packet_hash: "h",
          created_at: 0,
        },
      ],
    }),
  );
  expect(refsMatching(db, "knowledge_fts", "share")).toEqual(["K1"]);
  expect(refsMatching(db, "handoffs_fts", "rebuild")).toEqual(["H1"]);
  expect(refsMatching(db, "handoffs_fts", "exporter")).toEqual(["H1"]);

  exec(db, "UPDATE knowledge SET body_md = 'use local NVMe' WHERE id = 'K1'");
  exec(db, "UPDATE handoffs SET traps_md = 'timeouts hide it' WHERE id = 'H1'");
  expect(refsMatching(db, "knowledge_fts", "share")).toEqual([]);
  expect(refsMatching(db, "knowledge_fts", "nvme")).toEqual(["K1"]);
  expect(refsMatching(db, "handoffs_fts", "timeouts")).toEqual(["H1"]);
  exec(db, "UPDATE handoffs SET accepted_at = 1 WHERE id = 'H1'");
  expect(refsMatching(db, "handoffs_fts", "rebuild")).toEqual(["H1"]);

  exec(db, "DELETE FROM knowledge WHERE id = 'K1'");
  exec(db, "DELETE FROM handoffs WHERE id = 'H1'");
  expect(refsMatching(db, "knowledge_fts", "nvme")).toEqual([]);
  expect(refsMatching(db, "handoffs_fts", "rebuild")).toEqual([]);
  checkIndex(db, "knowledge_fts");
  checkIndex(db, "handoffs_fts");
});

test("sessions.mcp_token_hash is unique: a token names one session", async () => {
  const db = await dbAt(3);
  unwrap(await seedSpine(db, 3));
  const input = { ...newSessionInput(), mcp_token_hash: "a".repeat(64) };
  unwrap(await createSession(db, input));
  expect(await createSession(db, input)).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
});

test("one gate per ticket, kind, repo and attempt, even with no repo (a NULL repo_id)", async () => {
  const db = await dbAt(3);
  const gate = {
    id: "g-1",
    ticket_id: "ticket-1",
    kind: "code_review" as const,
    state: "running" as const,
    subject_kind: "diff",
    subject_ref: "HEAD",
  };
  unwrap(await seedRows(db, { tickets: [ticketRow(1)], gates: [gate] }));
  expect(await seedRows(db, { gates: [{ ...gate, id: "g-2" }] })).toMatchObject(
    { ok: false, error: { class: "conflict" } },
  );
  unwrap(await seedRows(db, { gates: [{ ...gate, id: "g-3", attempt: 2 }] }));
});

test("003 refuses a database where two sessions share a token hash, and applies nothing", async () => {
  const db = await dbAt(2);
  unwrap(await seedSpine(db, 2));
  const shared = { ...newSessionInput(), mcp_token_hash: "b".repeat(64) };
  unwrap(await createSession(db, { ...shared, id: "twin-1" }));
  unwrap(await createSession(db, { ...shared, id: "twin-2" }));
  expect(await migrateUp(db, { to: 3 })).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
  expect(
    unwrap(await migrationStatus(db)).applied.map((m) => m.version),
  ).toEqual([1, 2]);
});

test("both views run on an empty database", async () => {
  const raw = rawOf(await dbAt(3));
  expect(raw.prepare("SELECT * FROM v_needs_attention").all()).toEqual([]);
  expect(raw.prepare("SELECT * FROM v_ticket_economics").all()).toEqual([]);
});

test("003 down on a seeded database leaves exactly the 002 schema and keeps the tickets", async () => {
  const db = await dbAt(2);
  unwrap(await seedSpine(db, 2));
  unwrap(await seedRows(db, { tickets: [ticketRow(1)] }));
  const at2 = dump(db);
  unwrap(await migrateUp(db, { to: 3 }));
  unwrap(
    await seedRows(db, {
      ticket_events: [
        { ticket_id: "ticket-1", ts: 0, actor_kind: "operator", kind: "note" },
      ],
      knowledge: [
        {
          id: "K1",
          scope: "repo",
          kind: "trap",
          title: "t",
          body_md: "b",
          created_at: 0,
        },
      ],
    }),
  );
  const status = unwrap(await migrateDown(db));
  expect(status.applied.map((m) => m.version)).toEqual([1, 2]);
  expect(dump(db)).toBe(at2);
  expect(rawOf(db).prepare("SELECT id FROM tickets").all()).toEqual([
    { id: "ticket-1" },
  ]);
});
