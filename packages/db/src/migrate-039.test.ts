import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, unwrap } from "./testing.js";

// 039_push_url (M8.1): one nullable column on `repos` and one on `deliveries`, on an empty database and on one that already
// holds repos, up and down. Every repo comes up with no push target, so it pushes to its
// origin_url exactly as it did under 038.
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
const columnsOf = (db: Db, table = "repos") =>
  Columns.parse(
    rawOf(db)
      .prepare(
        `SELECT name, type, "notnull" FROM pragma_table_info('${table}') ORDER BY cid`,
      )
      .all(),
  );

/** The last column of `deliveries`: 039 adds the target a delivery went to. */
const lastDeliveryColumn = (db: Db) => columnsOf(db, "deliveries").at(-1);

const BEFORE = [
  "id",
  "name",
  "origin_url",
  "mirror_path",
  "default_base_branch",
  "image",
  "test_cmd",
  "lint_cmd",
  "build_cmd",
  "install_cmd",
  "doctrine_paths_json",
  "has_submodules",
];

const ADDED = { name: "push_url", type: "TEXT", notnull: 0 };

test("039 on an empty database adds repos.push_url and deliveries.remote_url, nullable; down removes both", async () => {
  const db = await dbAt(38);
  expect(columnsOf(db).map((c) => c.name)).toEqual(BEFORE);
  expect(lastDeliveryColumn(db)?.name).toBe("ended_at");

  unwrap(await migrateUp(db, { to: 39 }));
  expect(await version(db)).toBe(39);
  expect(columnsOf(db).slice(BEFORE.length)).toEqual([ADDED]);
  expect(lastDeliveryColumn(db)).toEqual({
    name: "remote_url",
    type: "TEXT",
    notnull: 0,
  });

  const insert = rawOf(db).prepare(
    "INSERT INTO repos (id, name, mirror_path, push_url) VALUES (?, ?, '/m', ?)",
  );
  insert.run("R-A", "R-A", null);
  insert.run("R-B", "R-B", "git@forge.example:owner/repo.git");
  expect(
    rawOf(db).prepare("SELECT id, push_url FROM repos ORDER BY id").all(),
  ).toEqual([
    { id: "R-A", push_url: null },
    { id: "R-B", push_url: "git@forge.example:owner/repo.git" },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(38);
  expect(columnsOf(db).map((c) => c.name)).toEqual(BEFORE);
  expect(lastDeliveryColumn(db)?.name).toBe("ended_at");

  unwrap(await migrateUp(db, { to: 39 }));
  expect(columnsOf(db).slice(BEFORE.length)).toEqual([ADDED]);
});

test("039 on a database holding repos and deliveries keeps every row, none with a target", async () => {
  const db = await dbAt(38);
  unwrap(
    await seedRows(db, {
      repos: [
        {
          id: "R-A",
          name: "R-A",
          origin_url: "/src/a",
          mirror_path: "/m/a.git",
          doctrine_paths_json: "[]",
        },
        {
          id: "R-B",
          name: "R-B",
          origin_url: "https://forge.example/owner/b.git",
          mirror_path: "/m/b.git",
          default_base_branch: "trunk",
          doctrine_paths_json: "[]",
          has_submodules: 1,
        },
      ],
    }),
  );
  const rows = (columns: readonly string[]): unknown =>
    rawOf(db)
      .prepare(`SELECT ${columns.join(", ")} FROM repos ORDER BY id`)
      .all();
  const before = rows(BEFORE);

  rawOf(db)
    .prepare(
      "INSERT INTO tickets (id, num, title, type, status, origin, created_at, updated_at) VALUES ('T1', 1, 't', 'chore', 'done', 'operator', 1, 1)",
    )
    .run();
  rawOf(db)
    .prepare(
      "INSERT INTO deliveries (id, ticket_id, repo_id, branch, head_sha, state, started_at) VALUES ('D1', 'T1', 'R-A', 'frm/s', 'abc', 'pushed', 1)",
    )
    .run();

  unwrap(await migrateUp(db, { to: 39 }));
  expect(rows(BEFORE)).toEqual(before);
  // A delivery from before 039 went to origin_url, and says nothing else.
  expect(
    rawOf(db).prepare("SELECT id, head_sha, remote_url FROM deliveries").all(),
  ).toEqual([{ id: "D1", head_sha: "abc", remote_url: null }]);
  expect(rows(["id", "push_url"])).toEqual([
    { id: "R-A", push_url: null },
    { id: "R-B", push_url: null },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(38);
  expect(rows(BEFORE)).toEqual(before);
  expect(
    rawOf(db).prepare("SELECT id, head_sha FROM deliveries").all(),
  ).toEqual([{ id: "D1", head_sha: "abc" }]);
});
