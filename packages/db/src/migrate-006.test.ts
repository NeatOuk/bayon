import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp } from "./migrate.js";
import { insertEventsBatch, type EventInsert } from "./repos/events.js";
import { getSession } from "./repos/sessions.js";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "./testing.js";

// 006_tool_call_index: a partial index on tool_call rows by (session, call id), for the
// tool-call counter pairing a `command` with its `tool_call`. An index only: no row changes.
const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const raw = (db: Db) => unwrap(internalsOf(db)).raw;
const INDEX = "events_tool_call_idx";

const indexes = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'events'",
        )
        .pluck()
        .all(),
    );

/** The counter's pairing lookup, as isInvocation (repos/events.ts) builds it. */
const PAIRING =
  "SELECT id FROM events WHERE session_id = ? AND kind = 'tool_call' AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.call_id') END) = ? LIMIT 1";
const plan = (db: Db): string =>
  z
    .array(z.object({ detail: z.string() }))
    .parse(raw(db).prepare(`EXPLAIN QUERY PLAN ${PAIRING}`).all("s", "c1"))
    .map((row) => row.detail)
    .join("\n");

const event = (kind: "tool_call" | "command", offset: number): EventInsert => ({
  session_id: SPINE_SEED.sessionId,
  ts: T0,
  kind,
  runner_type: "fixture.line",
  payload_json: JSON.stringify({ call_id: "c1" }),
  raw_offset: offset,
});

const toolCalls = async (db: Db) =>
  unwrap(await getSession(db, SPINE_SEED.sessionId)).tool_calls;

test("006 runs on an empty database, and the counter's pairing lookup uses its index", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 6 }));
  expect(indexes(db)).toContain(INDEX);
  expect(plan(db)).toContain(INDEX);
});

test("006 on a seeded database indexes the stored tool calls, and a later command pairs with one", async () => {
  const db = await dbAt(5);
  unwrap(await seedSpine(db, 5));
  unwrap(await insertEventsBatch(db, [event("tool_call", 0)]));
  expect(indexes(db)).not.toContain(INDEX);
  unwrap(await migrateUp(db, { to: 6 }));
  expect(plan(db)).toContain(INDEX);
  unwrap(await insertEventsBatch(db, [event("command", 1)]));
  expect(await toolCalls(db)).toBe(1);
});

test("006 down drops only the index and keeps the rows", async () => {
  const db = await dbAt(6);
  unwrap(await seedSpine(db, 6));
  unwrap(
    await insertEventsBatch(db, [event("tool_call", 0), event("command", 1)]),
  );
  unwrap(await migrateDown(db));
  expect(indexes(db)).not.toContain(INDEX);
  expect(plan(db)).not.toContain(INDEX);
  expect(raw(db).prepare("SELECT count(*) FROM events").pluck().get()).toBe(2);
  expect(await toolCalls(db)).toBe(1);
});
