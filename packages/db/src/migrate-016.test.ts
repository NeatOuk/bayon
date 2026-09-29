import { AgentGitAuthor, FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { tempDb, unwrap } from "./testing.js";

// 016_agent_git_author: the agents' git identity setting, on an empty database and on
// one where an operator already set it, up and down.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const KEY = "agents.git_author";

const Row = z.object({ value_json: z.string() }).optional();
const authorOf = (db: Db): string | undefined =>
  Row.parse(
    rawOf(db).prepare("SELECT value_json FROM settings WHERE key = ?").get(KEY),
  )?.value_json;

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

test("016 on an empty database seeds the default identity, which core parses; down removes it", async () => {
  const db = await dbAt(15);
  expect(authorOf(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: 16 }));
  expect(await version(db)).toBe(16);
  const value = authorOf(db);
  expect(value).toBe('"Bayon Agent <agent@bayon.invalid>"');
  expect(AgentGitAuthor.parse(JSON.parse(value ?? "null"))).toEqual({
    name: "Bayon Agent",
    email: "agent@bayon.invalid",
  });
  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(15);
  expect(authorOf(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: 16 }));
  expect(authorOf(db)).toBe('"Bayon Agent <agent@bayon.invalid>"');
});

test("016 on a seeded database keeps an operator's own identity and the other settings", async () => {
  const db = await dbAt(15);
  const own = '"Fleet Bot <bot@example.invalid>"';
  rawOf(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, 1)",
    )
    .run(KEY, own);
  const count = (): unknown =>
    rawOf(db).prepare("SELECT count(*) AS n FROM settings").get();
  const before = count();
  unwrap(await migrateUp(db, { to: 16 }));
  expect(authorOf(db)).toBe(own);
  expect(count()).toEqual(before);
  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(15);
  expect(authorOf(db)).toBeUndefined();
});
