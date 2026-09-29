import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, unwrap } from "./testing.js";

// 038_delivery: the two `workspaces` delivery columns and the `deliveries` table, on an
// empty database and on one that already holds projects, up and down. Every project comes up
// `none`/`review_passed`, so no branch of anyone's leaves this host until an operator says so (§14).
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

const BEFORE = [
  "id",
  "name",
  "kind",
  "default_executor_id",
  "default_runner_id",
  "paused",
  "staff_approval",
  "jira_url",
  "jira_email",
  "jira_jql",
  "qa_mode",
  "qa_cmd",
  "qa_timeout_ms",
  "qa_secrets_json",
  "qa_reports_json",
  "qa_junit",
  "docs_kind",
  "docs_url",
  "docs_email",
  "docs_spaces_json",
];

const ADDED = [
  { name: "delivery_mode", type: "TEXT", notnull: 1 },
  { name: "delivery_when", type: "TEXT", notnull: 1 },
];

const project = (
  db: Db,
  id: string,
  mode: unknown = undefined,
  when: unknown = undefined,
) =>
  mode === undefined
    ? rawOf(db)
        .prepare(
          "INSERT INTO workspaces (id, name, kind) VALUES (?, ?, 'single')",
        )
        .run(id, id)
    : rawOf(db)
        .prepare(
          "INSERT INTO workspaces (id, name, kind, delivery_mode, delivery_when) VALUES (?, ?, 'single', ?, ?)",
        )
        .run(id, id, mode, when);

const tables = (db: Db): string[] =>
  z
    .array(z.object({ name: z.string() }))
    .parse(
      rawOf(db)
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all(),
    )
    .map((r) => r.name);

const seedRepoAndTicket = (db: Db): void => {
  rawOf(db)
    .prepare(
      "INSERT INTO repos (id, name, mirror_path) VALUES ('R1', 'R1', '/m/R1')",
    )
    .run();
  rawOf(db)
    .prepare(
      "INSERT INTO tickets (id, num, title, type, status, origin, created_at, updated_at) VALUES ('T1', 1, 't', 'chore', 'qa_human', 'operator', 1, 1)",
    )
    .run();
};

test("038 on an empty database adds the delivery columns and deliveries; down removes both", async () => {
  const db = await dbAt(37);
  expect(columnsOf(db, "workspaces").map((c) => c.name)).toEqual(BEFORE);
  expect(tables(db)).not.toContain("deliveries");

  unwrap(await migrateUp(db, { to: 38 }));
  expect(await version(db)).toBe(38);
  expect(columnsOf(db, "workspaces").slice(BEFORE.length)).toEqual(ADDED);
  expect(tables(db)).toContain("deliveries");

  // The default is `none`: delivery is a standing operator approval, never assumed (§14).
  project(db, "P-A");
  expect(
    rawOf(db)
      .prepare(
        "SELECT delivery_mode, delivery_when FROM workspaces WHERE id = 'P-A'",
      )
      .get(),
  ).toEqual({ delivery_mode: "none", delivery_when: "review_passed" });
  project(db, "P-B", "push", "done");
  project(db, "P-C", "pull_request", "review_passed");

  // A mode or a moment outside the sets is refused.
  expect(() => project(db, "P-X", "sometimes", "done")).toThrow(
    /CHECK constraint/,
  );
  expect(() => project(db, "P-Y", "push", "when_i_say")).toThrow(
    /CHECK constraint/,
  );

  seedRepoAndTicket(db);
  const delivery = (id: string, state: string, repo = "R1") =>
    rawOf(db)
      .prepare(
        "INSERT INTO deliveries (id, ticket_id, repo_id, branch, state, started_at) VALUES (?, 'T1', ?, 'frm/s', ?, 1)",
      )
      .run(id, repo, state);
  for (const state of ["pushed", "pr_open", "failed"]) {
    delivery(`D-${state}`, state);
    rawOf(db).prepare("DELETE FROM deliveries").run();
  }
  expect(() => delivery("D-bad", "maybe")).toThrow(/CHECK constraint/);

  // One row per (ticket, repo): the index is what makes the job idempotent at the database.
  delivery("D-1", "pushed");
  expect(() => delivery("D-2", "pushed")).toThrow(/UNIQUE constraint/);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(37);
  expect(columnsOf(db, "workspaces").map((c) => c.name)).toEqual(BEFORE);
  expect(tables(db)).not.toContain("deliveries");

  unwrap(await migrateUp(db, { to: 38 }));
  expect(columnsOf(db, "workspaces").slice(BEFORE.length)).toEqual(ADDED);
});

test("038 on a database holding projects keeps every row, none delivering", async () => {
  const db = await dbAt(37);
  unwrap(
    await seedRows(db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single", staff_approval: 1 },
        { id: "P-B", name: "P-B", kind: "multi", paused: 1, qa_mode: "none" },
      ],
    }),
  );
  const rows = (columns: readonly string[]): unknown =>
    rawOf(db)
      .prepare(`SELECT ${columns.join(", ")} FROM workspaces ORDER BY id`)
      .all();
  const before = rows(BEFORE);

  unwrap(await migrateUp(db, { to: 38 }));
  expect(rows(BEFORE)).toEqual(before);
  expect(rows(["id", "delivery_mode", "delivery_when"])).toEqual([
    { id: "P-A", delivery_mode: "none", delivery_when: "review_passed" },
    { id: "P-B", delivery_mode: "none", delivery_when: "review_passed" },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(37);
  expect(rows(BEFORE)).toEqual(before);
});
