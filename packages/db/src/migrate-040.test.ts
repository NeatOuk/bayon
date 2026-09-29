import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, unwrap } from "./testing.js";

// 040_merge_close (M8.2): `deliveries` rebuilt with two more states and the merge's
// columns, and `workspaces.close_on_merge`, on an empty database and on one holding deliveries, up
// and down. Down restores 039's stored table text byte for byte.
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
const columnsOf = (db: Db, table: string) =>
  Columns.parse(
    rawOf(db)
      .prepare(
        `SELECT name, type, "notnull" FROM pragma_table_info('${table}') ORDER BY cid`,
      )
      .all(),
  );

const Sql = z.object({ sql: z.string() });
const stored = (db: Db, name: string): string =>
  Sql.parse(
    rawOf(db).prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name),
  ).sql;

const Index = z.array(z.object({ name: z.string() }));
const indexesOf = (db: Db): string[] =>
  Index.parse(
    rawOf(db)
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'deliveries' AND sql IS NOT NULL ORDER BY name",
      )
      .all(),
  ).map((r) => r.name);

const seedTicket = (db: Db): void => {
  rawOf(db)
    .prepare(
      "INSERT INTO repos (id, name, mirror_path) VALUES ('R-A', 'R-A', '/m/a.git'), ('R-B', 'R-B', '/m/b.git')",
    )
    .run();
  rawOf(db)
    .prepare(
      "INSERT INTO tickets (id, num, title, type, status, origin, created_at, updated_at) VALUES ('T1', 1, 't', 'chore', 'qa_human', 'operator', 1, 1)",
    )
    .run();
};

const insertDelivery = (
  db: Db,
  id: string,
  repo: string,
  state: string,
): void => {
  rawOf(db)
    .prepare(
      "INSERT INTO deliveries (id, ticket_id, repo_id, branch, head_sha, state, pr_url, pr_number, started_at, remote_url) VALUES (?, 'T1', ?, 'frm/s', 'abc', ?, 'https://forge.test/pull/1', 1, 1, 'https://forge.test/o/r.git')",
    )
    .run(id, repo, state);
};

test("040 on an empty database widens deliveries.state and adds the merge columns; down restores 039's table text", async () => {
  const db = await dbAt(39);
  const before = stored(db, "deliveries");
  expect(columnsOf(db, "deliveries").at(-1)?.name).toBe("remote_url");

  unwrap(await migrateUp(db, { to: 40 }));
  expect(await version(db)).toBe(40);
  expect(columnsOf(db, "deliveries").slice(-3)).toEqual([
    { name: "remote_url", type: "TEXT", notnull: 0 },
    { name: "merged_at", type: "INTEGER", notnull: 0 },
    { name: "merged_by", type: "TEXT", notnull: 0 },
  ]);
  expect(columnsOf(db, "workspaces").at(-1)).toEqual({
    name: "close_on_merge",
    type: "INTEGER",
    notnull: 1,
  });
  expect(indexesOf(db)).toEqual([
    "deliveries_state_idx",
    "deliveries_ticket_repo_idx",
  ]);
  seedTicket(db);
  insertDelivery(db, "D1", "R-A", "merged");
  insertDelivery(db, "D2", "R-B", "closed");
  expect(() => insertDelivery(db, "D3", "R-A", "gone")).toThrow(/CHECK/);
  // The unique (ticket, repo) index survived the rebuild.
  expect(() => insertDelivery(db, "D4", "R-A", "pr_open")).toThrow(/UNIQUE/);
  rawOf(db)
    .prepare(
      "INSERT INTO workspaces (id, name, kind) VALUES ('W', 'W', 'single')",
    )
    .run();
  expect(
    rawOf(db).prepare("SELECT close_on_merge FROM workspaces").get(),
  ).toEqual({ close_on_merge: 1 });
  expect(() =>
    rawOf(db).prepare("UPDATE workspaces SET close_on_merge = 2").run(),
  ).toThrow(/CHECK/);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(39);
  expect(stored(db, "deliveries")).toBe(before);
  expect(indexesOf(db)).toEqual(["deliveries_ticket_repo_idx"]);
  expect(columnsOf(db, "workspaces").at(-1)?.name).toBe("delivery_when");
  // A merged or closed request goes back to the one state 039 knows it by.
  expect(
    rawOf(db).prepare("SELECT id, state FROM deliveries ORDER BY id").all(),
  ).toEqual([
    { id: "D1", state: "pr_open" },
    { id: "D2", state: "pr_open" },
  ]);

  unwrap(await migrateUp(db, { to: 40 }));
  expect(await version(db)).toBe(40);
});

test("040 on a database holding deliveries keeps every row and column, none merged", async () => {
  const db = await dbAt(39);
  unwrap(
    await seedRows(db, {
      workspaces: [{ id: "W1", name: "W1", kind: "single" }],
    }),
  );
  seedTicket(db);
  insertDelivery(db, "D1", "R-A", "pr_open");
  insertDelivery(db, "D2", "R-B", "failed");
  const COLS =
    "id, ticket_id, repo_id, branch, head_sha, remote_host, state, pr_url, pr_number, error, started_at, ended_at, remote_url";
  const rows = (): unknown =>
    rawOf(db).prepare(`SELECT ${COLS} FROM deliveries ORDER BY id`).all();
  const before = rows();

  unwrap(await migrateUp(db, { to: 40 }));
  expect(rows()).toEqual(before);
  expect(
    rawOf(db)
      .prepare("SELECT merged_at, merged_by FROM deliveries ORDER BY id")
      .all(),
  ).toEqual([
    { merged_at: null, merged_by: null },
    { merged_at: null, merged_by: null },
  ]);
  // Every project here closes on merge unless the operator turns it off.
  expect(
    rawOf(db).prepare("SELECT id, close_on_merge FROM workspaces").all(),
  ).toEqual([{ id: "W1", close_on_merge: 1 }]);

  unwrap(await migrateDown(db));
  expect(rows()).toEqual(before);
});
