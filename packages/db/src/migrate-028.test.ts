import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, ticketRow, unwrap } from "./testing.js";

// 028_tickets_workspace_index: the index a project's ticket reads use, on an empty
// database and on one that already holds tickets in projects, up and down. The plan assertion is
// the point: an index SQLite declines to use would fix nothing.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const INDEX = "tickets_workspace_status_idx";

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const Names = z.array(z.object({ name: z.string() }));
const indexNames = (db: Db): string[] =>
  Names.parse(
    rawOf(db)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all(),
  ).map((r) => r.name);

/** A project's tickets by status: the shape of the pack's counts and its scoped ticket reads. */
const BY_PROJECT = `
  SELECT status, count(*) AS n FROM tickets WHERE workspace_id = ? GROUP BY status`;

const Plan = z.array(z.object({ detail: z.string() }));
const planOf = (db: Db): string =>
  Plan.parse(rawOf(db).prepare(`EXPLAIN QUERY PLAN ${BY_PROJECT}`).all("P-A"))
    .map((r) => r.detail)
    .join(" · ");

const byProject = (db: Db): unknown => rawOf(db).prepare(BY_PROJECT).all("P-A");

test("028 on an empty database adds the index a project's ticket reads use; down removes it", async () => {
  const db = await dbAt(27);
  expect(indexNames(db)).not.toContain(INDEX);
  expect(planOf(db)).not.toContain(INDEX);

  unwrap(await migrateUp(db, { to: 28 }));
  expect(await version(db)).toBe(28);
  expect(indexNames(db)).toContain(INDEX);
  expect(planOf(db)).toContain(INDEX);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(27);
  expect(indexNames(db)).not.toContain(INDEX);
  expect(planOf(db)).not.toContain(INDEX);

  unwrap(await migrateUp(db, { to: 28 }));
  expect(indexNames(db)).toContain(INDEX);
});

test("028 on a database holding projects' tickets keeps every row, and the read answers the same", async () => {
  const db = await dbAt(27);
  unwrap(
    await seedRows(db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
      tickets: [
        ticketRow(1, { workspace_id: "P-A", status: "prioritized" }),
        ticketRow(2, { workspace_id: "P-A", status: "prioritized" }),
        ticketRow(3, { workspace_id: "P-A", status: "building" }),
        ticketRow(4, { workspace_id: "P-B", status: "prioritized" }),
        ticketRow(5),
      ],
    }),
  );
  const count = (): unknown =>
    rawOf(db).prepare("SELECT count(*) AS n FROM tickets").get();
  const before = count();
  const expected = [
    { status: "building", n: 1 },
    { status: "prioritized", n: 2 },
  ];
  expect(byProject(db)).toEqual(expected);

  unwrap(await migrateUp(db, { to: 28 }));
  expect(count()).toEqual(before);
  expect(planOf(db)).toContain(INDEX);
  expect(byProject(db)).toEqual(expected);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(27);
  expect(indexNames(db)).not.toContain(INDEX);
  expect(count()).toEqual(before);
  expect(byProject(db)).toEqual(expected);
});
