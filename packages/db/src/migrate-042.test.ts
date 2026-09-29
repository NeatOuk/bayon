import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, tempDb, unwrap } from "./testing.js";

// 042_jira_quick_sync (M8.5): the quick pass's seeded `jira.quick_interval_ms`, on an
// empty database and on one that already holds projects and settings, up, down and up again. An
// operator's own value stays; nothing else moves.
const V = 42;
const KEY = "jira.quick_interval_ms";
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

const Rows = z.array(z.object({ key: z.string(), value_json: z.string() }));
const settings = (db: Db) =>
  Rows.parse(
    rawOf(db)
      .prepare("SELECT key, value_json FROM settings ORDER BY key")
      .all(),
  );
const quickOf = (db: Db): string | undefined =>
  settings(db).find((r) => r.key === KEY)?.value_json;

test("042 on an empty database seeds the quick interval at a minute; down removes it; up seeds it again", async () => {
  const db = await dbAt(V - 1);
  const before = settings(db);
  expect(quickOf(db)).toBeUndefined();

  unwrap(await migrateUp(db, { to: V }));
  expect(await version(db)).toBe(V);
  expect(quickOf(db)).toBe("60000");
  expect(settings(db).filter((r) => r.key !== KEY)).toEqual(before);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(V - 1);
  expect(settings(db)).toEqual(before);

  unwrap(await migrateUp(db, { to: V }));
  expect(quickOf(db)).toBe("60000");
});

test("042 on a database holding projects keeps them, and an interval an operator already set", async () => {
  const db = await dbAt(V - 1);
  unwrap(
    await seedRows(db, {
      workspaces: [
        {
          id: "P-A",
          name: "P-A",
          kind: "single",
          jira_url: "https://acme.atlassian.net",
          jira_email: "op@acme.test",
          jira_jql: "project = A",
        },
        { id: "P-B", name: "P-B", kind: "multi" },
      ],
    }),
  );
  rawOf(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, '0', 1)",
    )
    .run(KEY);
  rawOf(db)
    .prepare("UPDATE settings SET value_json = '120000' WHERE key = ?")
    .run("jira.sync_interval_ms");
  const workspaces = (): unknown =>
    rawOf(db).prepare("SELECT * FROM workspaces ORDER BY id").all();
  const projects = workspaces();
  const before = settings(db);

  unwrap(await migrateUp(db, { to: V }));
  expect(quickOf(db)).toBe("0");
  expect(settings(db)).toEqual(before);
  expect(workspaces()).toEqual(projects);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(V - 1);
  expect(quickOf(db)).toBeUndefined();
  expect(settings(db).find((r) => r.key === "jira.sync_interval_ms")).toEqual({
    key: "jira.sync_interval_ms",
    value_json: "120000",
  });
  expect(workspaces()).toEqual(projects);

  unwrap(await migrateUp(db, { to: V }));
  expect(quickOf(db)).toBe("60000");
});
