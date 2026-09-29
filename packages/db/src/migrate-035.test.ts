import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp } from "./migrate.js";
import { seedRows, seedSpine, tempDb, ticketRow, unwrap } from "./testing.js";

// 035_why_stuck: `gate_stuck` lists a failed gate only while its ticket waits behind it,
// and `advance_pending` lists a round that passed with the ticket still in review. Every other arm
// is 025's, and down is 025's view again. The view's clock is SQLite's own, so ages are wall-clock.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const MINUTE = 60_000;

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const raw = (db: Db) => unwrap(internalsOf(db)).raw;

/** Every arm the view lists, as `why:ref` pairs, so one arm's change is visible against the rest. */
const attention = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(
          "SELECT why || ':' || ref FROM v_needs_attention ORDER BY why, ref",
        )
        .pluck()
        .all(),
    );

const gateSql =
  "INSERT INTO gates (id, ticket_id, kind, state, attempt, round, subject_kind, subject_ref, " +
  "evidence_json, decided_at) VALUES (?, ?, 'code_review', ?, ?, ?, 'diff', 'HEAD', ?, ?)";

/** The live fleet's shape: a no_reviewer failure a later attempt passed, on a ticket in review. */
function seedStall(db: Db): void {
  const settled = Date.now() - 10 * MINUTE;
  const insert = raw(db).prepare(gateSql);
  insert.run(
    "old",
    "ticket-1",
    "failed",
    1,
    1,
    '{"reason":"no_reviewer"}',
    settled,
  );
  insert.run("new", "ticket-1", "passed", 2, 2, null, settled);
  // A ticket whose latest attempt failed and that still sits in code_review.
  insert.run(
    "stuck",
    "ticket-2",
    "failed",
    1,
    1,
    '{"reason":"timeout"}',
    settled,
  );
}

async function seededAt(to: number): Promise<Db> {
  const db = await dbAt(to);
  unwrap(await seedSpine(db, to));
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(1, {
          status: "code_review",
          updated_at: Date.now() - 10 * MINUTE,
        }),
        ticketRow(2, {
          status: "code_review",
          updated_at: Date.now() - 10 * MINUTE,
        }),
        ticketRow(3, { status: "prioritized" }),
      ],
    }),
  );
  seedStall(db);
  return db;
}

/** Whether `sessions.gate_id`'s partial index is there: what the board's wait facts ask through. */
const hasGateIndex = (db: Db): boolean =>
  raw(db)
    .prepare(
      "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'sessions_gate_idx'",
    )
    .pluck()
    .get() === 1;

test("035 on an empty database migrates, indexes sessions.gate_id, and its arms list nothing", async () => {
  const db = await dbAt(34);
  expect(attention(db)).toEqual([]);
  expect(hasGateIndex(db)).toBe(false);
  unwrap(await migrateUp(db, { to: 35 }));
  expect(attention(db)).toEqual([]);
  expect(hasGateIndex(db)).toBe(true);
  unwrap(await migrateDown(db));
  expect(attention(db)).toEqual([]);
  expect(hasGateIndex(db)).toBe(false);
});

test("035 on a seeded database: gate_stuck keeps the latest failure, advance_pending is new", async () => {
  const db = await seededAt(34);
  const before = attention(db);
  // 025 listed every failure ever, the one a newer attempt passed included.
  expect(before).toEqual([
    "gate_stuck:old",
    "gate_stuck:stuck",
    "unstaffed_ready:ticket-3",
  ]);

  unwrap(await migrateUp(db, { to: 35 }));
  expect(attention(db)).toEqual([
    "advance_pending:ticket-1",
    "gate_stuck:stuck",
    "unstaffed_ready:ticket-3",
  ]);

  // Down is 025's view: every failure again, and no advance_pending.
  unwrap(await migrateDown(db));
  expect(attention(db)).toEqual(before);
});

test("035 leaves every other arm exactly as 025 had it", async () => {
  const db = await seededAt(34);
  raw(db)
    .prepare(
      "INSERT INTO messages (id, ts, from_kind, from_id, to_kind, to_id, kind, subject, body_md, ticket_id) " +
        "VALUES ('m-1', 1, 'human', 'operator', 'agent', 'agent-fixture', 'note', 's', 'b', 'ticket-3')",
    )
    .run();
  const others = (rows: readonly string[]) =>
    rows.filter(
      (r) => !r.startsWith("gate_stuck:") && !r.startsWith("advance_pending:"),
    );
  const before = others(attention(db));
  expect(before).toContain("unread_message:m-1");
  unwrap(await migrateUp(db, { to: 35 }));
  expect(others(attention(db))).toEqual(before);
});
