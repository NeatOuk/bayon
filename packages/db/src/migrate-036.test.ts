import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, unwrap } from "./testing.js";

// 036_qa_harness: the six `workspaces` QA columns and the `qa_runs` table, on an empty
// database and on one that already holds projects and tickets, up and down. Every project comes up
// with `qa_mode = 'none'`, so nothing opens a QA gate until an operator configures one.
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
];

const ADDED = [
  { name: "qa_mode", type: "TEXT", notnull: 1 },
  { name: "qa_cmd", type: "TEXT", notnull: 0 },
  { name: "qa_timeout_ms", type: "INTEGER", notnull: 0 },
  { name: "qa_secrets_json", type: "TEXT", notnull: 0 },
  { name: "qa_reports_json", type: "TEXT", notnull: 0 },
  { name: "qa_junit", type: "TEXT", notnull: 0 },
];

const project = (
  db: Db,
  id: string,
  mode: unknown = undefined,
  cmd: unknown = undefined,
) =>
  mode === undefined
    ? rawOf(db)
        .prepare(
          "INSERT INTO workspaces (id, name, kind) VALUES (?, ?, 'single')",
        )
        .run(id, id)
    : rawOf(db)
        .prepare(
          "INSERT INTO workspaces (id, name, kind, qa_mode, qa_cmd) VALUES (?, ?, 'single', ?, ?)",
        )
        .run(id, id, mode, cmd);

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

test("036 on an empty database adds the QA columns and qa_runs; down removes both", async () => {
  const db = await dbAt(35);
  expect(columnsOf(db, "workspaces").map((c) => c.name)).toEqual(BEFORE);
  expect(tables(db)).not.toContain("qa_runs");

  unwrap(await migrateUp(db, { to: 36 }));
  expect(await version(db)).toBe(36);
  expect(columnsOf(db, "workspaces").slice(BEFORE.length)).toEqual(ADDED);
  expect(tables(db)).toContain("qa_runs");

  // The default is `none`: a project configures a harness, it is never assumed to have one.
  project(db, "P-A");
  expect(
    rawOf(db).prepare("SELECT qa_mode FROM workspaces WHERE id = 'P-A'").get(),
  ).toEqual({ qa_mode: "none" });
  project(db, "P-B", "command", "make check");
  project(db, "P-C", "pending", null);

  // A mode outside the three, and `command` with nothing to run, are both refused.
  expect(() => project(db, "P-X", "sometimes", "make check")).toThrow(
    /CHECK constraint/,
  );
  for (const blank of [null, "", "   "]) {
    expect(() => project(db, "P-Y", "command", blank), String(blank)).toThrow(
      /CHECK constraint/,
    );
  }

  // qa_runs' own CHECK: the three states and nothing else.
  const run = (id: string, state: string) =>
    rawOf(db)
      .prepare(
        "INSERT INTO qa_runs (id, ticket_id, state, started_at) VALUES (?, 'T1', ?, 1)",
      )
      .run(id, state);
  rawOf(db)
    .prepare(
      "INSERT INTO tickets (id, num, title, type, status, origin, created_at, updated_at) VALUES ('T1', 1, 't', 'chore', 'qa_harness', 'operator', 1, 1)",
    )
    .run();
  for (const state of ["passed", "failed", "error"]) run(`R-${state}`, state);
  expect(() => run("R-bad", "flaky")).toThrow(/CHECK constraint/);
  expect(
    rawOf(db)
      .prepare("SELECT report_paths_json FROM qa_runs WHERE id = 'R-passed'")
      .get(),
  ).toEqual({ report_paths_json: "[]" });

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(35);
  expect(columnsOf(db, "workspaces").map((c) => c.name)).toEqual(BEFORE);
  expect(tables(db)).not.toContain("qa_runs");

  unwrap(await migrateUp(db, { to: 36 }));
  expect(columnsOf(db, "workspaces").slice(BEFORE.length)).toEqual(ADDED);
});

test("036 on a database holding projects keeps every row, none running a harness", async () => {
  const db = await dbAt(35);
  unwrap(
    await seedRows(db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single", staff_approval: 1 },
        { id: "P-B", name: "P-B", kind: "multi", paused: 1 },
      ],
    }),
  );
  const rows = (columns: readonly string[]): unknown =>
    rawOf(db)
      .prepare(`SELECT ${columns.join(", ")} FROM workspaces ORDER BY id`)
      .all();
  const before = rows(BEFORE);

  unwrap(await migrateUp(db, { to: 36 }));
  expect(rows(BEFORE)).toEqual(before);
  expect(rows(["id", "qa_mode", "qa_cmd", "qa_junit"])).toEqual([
    { id: "P-A", qa_mode: "none", qa_cmd: null, qa_junit: null },
    { id: "P-B", qa_mode: "none", qa_cmd: null, qa_junit: null },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(35);
  expect(rows(BEFORE)).toEqual(before);
});
