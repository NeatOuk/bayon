import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

// CLAUDE.md Invariant 6: all SQL lives in packages/db. The db entry points carry §9.5's writer
// discipline: the API never imports the supervisor's writers, the supervisor never imports the
// API's, and only tests import the test helpers.
const root = new URL("./", import.meta.url);
const SKIP = new Set(["node_modules", "dist", "coverage"]);

function filesUnder(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    return entry.isDirectory()
      ? filesUnder(new URL(`${entry.name}/`, dir))
      : [new URL(entry.name, dir)];
  });
}

const relative = (file: URL) => file.pathname.slice(root.pathname.length);
const workspaceFiles = ["apps", "packages", "tools"].flatMap((dir) =>
  filesUnder(new URL(`${dir}/`, root)).map(relative),
);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

// Uppercase only: SQL in this repo is written uppercase, and prose like "select a model from
// the list" must not trip it.
const SQL_STATEMENT =
  /\b(?:SELECT\b[^;]{0,200}?\bFROM|INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|(?:CREATE|DROP)\s+(?:UNIQUE\s+|VIRTUAL\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|PRAGMA\s+\w+)\b/;
const SQL_DRIVER = /["'](?:better-sqlite3|kysely|node:sqlite|sqlite3)["']/;

const isTest = (rel: string) => /\.test\.[cm]?[jt]sx?$/.test(rel);
const ENTRY_RULES = [
  {
    rule: "apps/api must not import @bayon/db/supervisor",
    applies: (rel: string) => rel.startsWith("apps/api/"),
    banned: /["']@bayon\/db\/supervisor["']/,
  },
  {
    rule: "apps/supervisor must not import @bayon/db/api",
    applies: (rel: string) => rel.startsWith("apps/supervisor/"),
    banned: /["']@bayon\/db\/api["']/,
  },
  {
    rule: "only tests import @bayon/db/testing",
    applies: (rel: string) => !isTest(rel),
    banned: /["']@bayon\/db\/testing["']/,
  },
  {
    rule: "only tests in packages/db import ./testing.js",
    applies: (rel: string) =>
      rel.startsWith("packages/db/src/") &&
      !isTest(rel) &&
      rel !== "packages/db/src/testing.ts",
    banned: /["']\.{1,2}\/(?:\.\.\/)*testing\.js["']/,
  },
  {
    rule: "apps must not import @bayon/db/operator",
    applies: (rel: string) => rel.startsWith("apps/"),
    banned: /["']@bayon\/db\/operator["']/,
  },
];

test("the detectors catch planted samples and ignore prose", () => {
  for (const sql of [
    'db.prepare("SELECT id FROM sessions WHERE id = ?")',
    "INSERT INTO events (id) VALUES (1)",
    "INSERT OR IGNORE INTO events (id) VALUES (1)",
    "UPDATE sessions SET state = 'idle'",
    "DELETE FROM commands",
    "CREATE UNIQUE INDEX x ON t(a)",
    "DROP TABLE events",
    "ALTER TABLE runs ADD COLUMN x",
    "PRAGMA journal_mode",
    "CREATE VIRTUAL TABLE tickets_fts USING fts5(title)",
    "CREATE TRIGGER t AFTER INSERT ON tickets BEGIN SELECT 1; END",
    "INSERT INTO tickets_fts (tickets_fts) VALUES ('rebuild')",
    "SELECT rowid FROM tickets_fts WHERE tickets_fts MATCH ?",
  ]) {
    expect(SQL_STATEMENT.test(sql), sql).toBe(true);
  }
  expect(
    SQL_STATEMENT.test(
      "// select a model from the list, then delete from disk",
    ),
  ).toBe(false);
  expect(SQL_DRIVER.test('import Database from "better-sqlite3";')).toBe(true);
  expect(SQL_DRIVER.test("import { Kysely } from 'kysely';")).toBe(true);
  expect(
    SQL_DRIVER.test('const { DatabaseSync } = await import("node:sqlite");'),
  ).toBe(true);
  expect(SQL_DRIVER.test('import { z } from "zod";')).toBe(false);

  const [api, supervisor, testing, local, operator] = ENTRY_RULES.map(
    (r) => r.banned,
  );
  expect(
    operator?.test('import { seedConfig } from "@bayon/db/operator";'),
  ).toBe(true);
  expect(operator?.test('import { getSession } from "@bayon/db";')).toBe(false);
  expect(api?.test('import { migrateUp } from "@bayon/db/supervisor";')).toBe(
    true,
  );
  expect(api?.test('import { getFleet } from "@bayon/db";')).toBe(false);
  expect(
    supervisor?.test('import { insertCommand } from "@bayon/db/api";'),
  ).toBe(true);
  // The M1 work writers (003): packages/db/src/entry-points.test.ts pins which entry exports each.
  expect(
    supervisor?.test(
      'import { createTicket, transitionTicket } from "@bayon/db/api";',
    ),
  ).toBe(true);
  expect(
    api?.test('import { upsertTicketExport } from "@bayon/db/supervisor";'),
  ).toBe(true);
  expect(testing?.test('import { tempDb } from "@bayon/db/testing";')).toBe(
    true,
  );
  expect(local?.test('import { tempDb } from "../testing.js";')).toBe(true);
  expect(local?.test('import { tempDb } from "./testing-helpers.js";')).toBe(
    false,
  );
});

test("packages/db is the only workspace with SQL", () => {
  expect(
    workspaceFiles.some((rel) => rel.startsWith("packages/db/migrations/")),
  ).toBe(true);
  const offenders = workspaceFiles
    .filter((rel) => !rel.startsWith("packages/db/"))
    .flatMap((rel) => {
      if (rel.endsWith(".sql")) return [`${rel}: a .sql file`];
      const text = read(rel);
      return [
        ...(SQL_STATEMENT.test(text) ? [`${rel}: an SQL statement`] : []),
        ...(SQL_DRIVER.test(text) ? [`${rel}: an SQL driver`] : []),
      ];
    });
  expect(offenders).toEqual([]);
});

test("the db entry points keep writer discipline (§9.5)", () => {
  const offenders = workspaceFiles.flatMap((rel) =>
    ENTRY_RULES.filter(
      ({ applies, banned }) => applies(rel) && banned.test(read(rel)),
    ).map(({ rule }) => `${rel}: ${rule}`),
  );
  expect(offenders).toEqual([]);
});
