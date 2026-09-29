import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { appendRun } from "./repos/runs.js";
import { createSession } from "./repos/sessions.js";
import {
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "./testing.js";

// 013_reconciler: sessions.spawn_request_json, runs.wall_clock_ms and the setting
// reconciler.command_max_attempts, on an empty and on a seeded database, down and up again.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;

const Columns = z.array(z.object({ name: z.string() }));
const columnsOf = (db: Db, table: string): string[] =>
  Columns.parse(
    rawOf(db)
      .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
      .all(table),
  ).map((c) => c.name);

const Setting = z.array(z.object({ value_json: z.string() }));
const maxAttempts = (db: Db): string | undefined =>
  Setting.parse(
    rawOf(db)
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .all("reconciler.command_max_attempts"),
  )[0]?.value_json;

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

test("013 on an empty database: both columns and the setting, and down removes them", async () => {
  const db = await dbAt(12);
  expect(columnsOf(db, "sessions")).not.toContain("spawn_request_json");
  expect(maxAttempts(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: 13 }));
  expect(await version(db)).toBe(13);
  expect(columnsOf(db, "sessions").at(-1)).toBe("spawn_request_json");
  expect(columnsOf(db, "runs").at(-1)).toBe("wall_clock_ms");
  expect(maxAttempts(db)).toBe("3");

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(12);
  expect(columnsOf(db, "sessions")).not.toContain("spawn_request_json");
  expect(columnsOf(db, "runs")).not.toContain("wall_clock_ms");
  expect(maxAttempts(db)).toBeUndefined();
  unwrap(await migrateUp(db, { to: 13 }));
  expect(maxAttempts(db)).toBe("3");
});

test("013 on a seeded database: old rows read NULL, new ones keep their values, down and up keep the rows", async () => {
  const db = await dbAt(12);
  unwrap(await seedSpine(db, 12));
  unwrap(await appendRun(db, newRunInput(SPINE_SEED.sessionId)));
  unwrap(await migrateUp(db, { to: 13 }));
  const Row = z.array(
    z.object({
      id: z.string(),
      v: z.union([z.string(), z.number(), z.null()]),
    }),
  );
  const sessions = () =>
    Row.parse(
      rawOf(db)
        .prepare("SELECT id, spawn_request_json AS v FROM sessions ORDER BY id")
        .all(),
    );
  const runs = () =>
    Row.parse(
      rawOf(db)
        .prepare("SELECT id, wall_clock_ms AS v FROM runs ORDER BY id")
        .all(),
    );
  expect(sessions()).toEqual([{ id: SPINE_SEED.sessionId, v: null }]);
  expect(runs().map((r) => r.v)).toEqual([null]);

  const payload =
    '{"agent_id":"a","role":"builder","run_class":"build","session_id":"s-013"}';
  unwrap(
    await createSession(db, {
      ...newSessionInput(),
      id: "s-013",
      mcp_token_hash: "hash-013",
      spawn_request_json: payload,
    }),
  );
  unwrap(
    await appendRun(db, { ...newRunInput("s-013"), wall_clock_ms: 60_000 }),
  );
  expect(sessions()).toContainEqual({ id: "s-013", v: payload });
  expect(runs().map((r) => r.v)).toContain(60_000);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(12);
  const count = z.array(z.object({ n: z.number() }));
  const n = (table: string) =>
    count.parse(
      rawOf(db).prepare(`SELECT count(*) AS n FROM ${table}`).all(),
    )[0]?.n;
  expect(n("sessions")).toBe(2);
  expect(n("runs")).toBe(2);
  unwrap(await migrateUp(db, { to: 13 }));
  expect(await version(db)).toBe(13);
  expect(sessions()).toContainEqual({ id: "s-013", v: null });
});

test("an operator's own value for the setting survives 013", async () => {
  const db = await dbAt(12);
  rawOf(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('reconciler.command_max_attempts', '5', 0)",
    )
    .run();
  unwrap(await migrateUp(db, { to: 13 }));
  expect(maxAttempts(db)).toBe("5");
});
