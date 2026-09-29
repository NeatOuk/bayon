import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp } from "./migrate.js";
import { listPendingHandoffs } from "./repos/handoffs.js";
import type { HandoffsTable } from "./schema-work.js";
import {
  rawAttentionForTest,
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "./testing.js";

// 005_handoff_writing (review HIGH 4): only v_needs_attention changes, so its
// handoff_pending arm is the one pending predicate: accepted_at IS NULL AND quality <> 'writing'.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const View = z.array(z.object({ sql: z.string() }));
const viewSql = (db: Db): string =>
  View.parse(
    unwrap(internalsOf(db))
      .raw.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'v_needs_attention'",
      )
      .all(),
  )[0]?.sql ?? "";

const handoff = (
  id: string,
  quality: string,
  accepted_at: number | null,
): Insertable<HandoffsTable> => ({
  id,
  ticket_id: "ticket-1",
  from_session_id: SPINE_SEED.sessionId,
  reason: "turn_ceiling",
  facts_json: "{}",
  quality,
  packet_path: `.foreman/${id}.md`,
  packet_hash: "0".repeat(64),
  accepted_at,
  created_at: 0,
});

/** Every quality, accepted or not, on a ticket of the seeded spine. */
async function seedHandoffs(db: Db): Promise<void> {
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(1, { status: "building" })],
      handoffs: [
        handoff("writing-open", "writing", null),
        handoff("writing-taken", "writing", 5),
        handoff("full-open", "full", null),
        handoff("full-taken", "full", 5),
        handoff("degraded-open", "degraded", null),
        handoff("degraded-taken", "degraded", 5),
      ],
    }),
  );
}

const pendingArm = async (db: Db) =>
  unwrap(await rawAttentionForTest(db))
    .filter((row) => row.why === "handoff_pending")
    .map((row) => row.ref)
    .toSorted();

test("005 runs on an empty database, and its arm leaves writing rows out", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 5 }));
  expect(viewSql(db)).toContain(
    "h.accepted_at IS NULL AND h.quality <> 'writing'",
  );
  expect(await pendingArm(db)).toEqual([]);
});

test("005 on a seeded database: the view and wherePendingHandoff agree on every quality", async () => {
  const db = await dbAt(4);
  unwrap(await seedSpine(db, 4));
  await seedHandoffs(db);
  // At 004 a writing row is still listed: the gap 005 closes.
  expect(await pendingArm(db)).toEqual([
    "degraded-open",
    "full-open",
    "writing-open",
  ]);
  unwrap(await migrateUp(db, { to: 5 }));
  const viaPredicate = unwrap(await listPendingHandoffs(db))
    .map((row) => row.id)
    .toSorted();
  expect(viaPredicate).toEqual(["degraded-open", "full-open"]);
  expect(await pendingArm(db)).toEqual(viaPredicate);
});

test("005 down restores 004's view byte for byte and keeps the rows", async () => {
  const at4 = await dbAt(4);
  const db = await dbAt(5);
  unwrap(await seedSpine(db, 5));
  await seedHandoffs(db);
  unwrap(await migrateDown(db));
  expect(viewSql(db)).toBe(viewSql(at4));
  expect(await pendingArm(db)).toHaveLength(3);
  unwrap(await migrateUp(db, { to: 5 }));
  expect(await pendingArm(db)).toHaveLength(2);
});
