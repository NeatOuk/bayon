import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, unwrap } from "./testing.js";

// 037_project_docs: the four `workspaces` documentation columns, on an empty database
// and on one that already holds projects, up and down. Every project comes up with
// `docs_kind = 'none'`, so nothing is readable until an operator names a source.
//
// No site or space name here is anyone's: they are placeholders, as every fixture in this repo is.
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
  "jira_url",
  "jira_email",
  "jira_jql",
  "qa_mode",
  "qa_cmd",
  "qa_timeout_ms",
  "qa_secrets_json",
  "qa_reports_json",
  "qa_junit",
];

const ADDED = [
  { name: "docs_kind", type: "TEXT", notnull: 1 },
  { name: "docs_url", type: "TEXT", notnull: 0 },
  { name: "docs_email", type: "TEXT", notnull: 0 },
  { name: "docs_spaces_json", type: "TEXT", notnull: 0 },
];

const SITE = "https://acme.atlassian.net";

const insert = (
  db: Db,
  id: string,
  docs: { kind?: unknown; url?: unknown; email?: unknown; spaces?: unknown },
) =>
  rawOf(db)
    .prepare(
      "INSERT INTO workspaces (id, name, kind, docs_kind, docs_url, docs_email, docs_spaces_json) VALUES (?, ?, 'single', ?, ?, ?, ?)",
    )
    .run(
      id,
      id,
      docs.kind ?? "none",
      docs.url ?? null,
      docs.email ?? null,
      docs.spaces ?? null,
    );

const rows = (db: Db, columns: readonly string[]): unknown =>
  rawOf(db)
    .prepare(`SELECT ${columns.join(", ")} FROM workspaces ORDER BY id`)
    .all();

test("037 on an empty database adds the four columns; a confluence source must have a site and an account", async () => {
  const db = await dbAt(36);
  expect(columnsOf(db).map((c) => c.name)).toEqual(BEFORE);

  unwrap(await migrateUp(db, { to: 37 }));
  expect(await version(db)).toBe(37);
  expect(columnsOf(db).slice(BEFORE.length)).toEqual(ADDED);

  insert(db, "P-A", {});
  insert(db, "P-B", {
    kind: "confluence",
    url: SITE,
    email: "op@acme.test",
    spaces: '["ONE","TWO"]',
  });
  // A kind outside the two, and a source that could only ever fail, are both refused.
  for (const [i, bad] of [
    { kind: "wiki" },
    { kind: "confluence" },
    { kind: "confluence", url: SITE },
    { kind: "confluence", email: "op@acme.test" },
  ].entries()) {
    expect(() => insert(db, `P-X${i}`, bad), String(i)).toThrow(
      /CHECK constraint/,
    );
  }

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(36);
  expect(columnsOf(db).map((c) => c.name)).toEqual(BEFORE);

  // Up again on the same file: the columns come back, and nothing of the kept rows is lost.
  unwrap(await migrateUp(db, { to: 37 }));
  expect(rows(db, ["id", "docs_kind", "docs_url"])).toEqual([
    { id: "P-A", docs_kind: "none", docs_url: null },
    { id: "P-B", docs_kind: "none", docs_url: null },
  ]);
});

test("037 on a database holding projects keeps every row, none with a source", async () => {
  const db = await dbAt(36);
  unwrap(
    await seedRows(db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single", staff_approval: 1 },
        { id: "P-B", name: "P-B", kind: "multi", paused: 1, qa_mode: "none" },
      ],
    }),
  );
  const before = rows(db, BEFORE);

  unwrap(await migrateUp(db, { to: 37 }));
  expect(rows(db, BEFORE)).toEqual(before);
  expect(
    rows(db, ["id", "docs_kind", "docs_url", "docs_email", "docs_spaces_json"]),
  ).toEqual([
    {
      id: "P-A",
      docs_kind: "none",
      docs_url: null,
      docs_email: null,
      docs_spaces_json: null,
    },
    {
      id: "P-B",
      docs_kind: "none",
      docs_url: null,
      docs_email: null,
      docs_spaces_json: null,
    },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(36);
  expect(rows(db, BEFORE)).toEqual(before);
});
