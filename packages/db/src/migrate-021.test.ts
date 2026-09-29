import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import {
  rawAttentionForTest,
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "./testing.js";

// 021_spawn_failed_arm: v_needs_attention rebuilt with one appended arm, on an empty
// and on a seeded database, down and up. What the arm *means* is proved against the real staffing
// and requeue writers in repos/spawn-failed-arm.test.ts; this file is about the migration.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;

const Sql = z.array(z.object({ sql: z.string() }));
const viewSql = (db: Db): string =>
  Sql.parse(
    rawOf(db)
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'v_needs_attention'",
      )
      .all(),
  )[0]?.sql ?? "";

const dump = (db: Db): string =>
  JSON.stringify(
    rawOf(db)
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      )
      .all(),
  );

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const spawnArm = async (db: Db) =>
  unwrap(await rawAttentionForTest(db)).filter(
    (row) => row.why === "spawn_failed",
  );

/** A ticket staffing moved and a session.spawn that never became a session row. */
async function seedStranded(db: Db): Promise<void> {
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(1, { status: "staffed" })],
      commands: [
        {
          id: "cmd-1",
          ts: 1,
          type: "session.spawn",
          payload_json: JSON.stringify({
            session_id: "S-never-written",
            agent_id: SPINE_SEED.agentId,
            ticket_id: "ticket-1",
          }),
          state: "failed",
          attempts: 3,
          error: JSON.stringify({
            class: "interrupted",
            message: "claimed 3 times without completing",
            retryable: false,
          }),
        },
      ],
    }),
  );
}

test("021 on an empty database appends one arm and changes nothing else; down and up are exact", async () => {
  const at20 = viewSql(await dbAt(20));
  const at21 = viewSql(await dbAt(21));
  // 015's text byte for byte, then the new arm: the arms above it cannot have drifted.
  expect(at21.slice(0, at20.length)).toBe(at20);
  const added = [...at21.slice(at20.length).matchAll(/SELECT '(\w+)'/g)];
  expect(added.map((m) => m[1])).toEqual(["spawn_failed"]);

  const schema20 = dump(await dbAt(20));
  const schema21 = dump(await dbAt(21));
  expect(schema21).not.toBe(schema20);
  const db = await dbAt(21);
  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(20);
  expect(dump(db)).toBe(schema20);
  unwrap(await migrateUp(db, { to: 21 }));
  expect(await version(db)).toBe(21);
  expect(dump(db)).toBe(schema21);
});

test("021 on a seeded database: the stranded ticket appears, and down hides it again with its rows intact", async () => {
  const db = await dbAt(20);
  unwrap(await seedSpine(db, 12));
  await seedStranded(db);
  // 020: nothing in the view knows about it — the bug.
  expect(await spawnArm(db)).toEqual([]);

  unwrap(await migrateUp(db, { to: 21 }));
  expect(await spawnArm(db)).toEqual([
    { why: "spawn_failed", ref: "cmd-1", ticket_id: "ticket-1" },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(20);
  expect(await spawnArm(db)).toEqual([]);
  const rows = z
    .array(z.object({ n: z.number() }))
    .parse(
      rawOf(db)
        .prepare(
          "SELECT (SELECT count(*) FROM commands) + (SELECT count(*) FROM tickets) AS n",
        )
        .all(),
    )[0]?.n;
  expect(rows).toBe(2);

  unwrap(await migrateUp(db, { to: 21 }));
  expect(await spawnArm(db)).toEqual([
    { why: "spawn_failed", ref: "cmd-1", ticket_id: "ticket-1" },
  ]);
});

test("021 ignores a spawn that is not the ticket's last, even one queued in the same millisecond", async () => {
  const db = await dbAt(21);
  unwrap(await seedSpine(db, 12));
  await seedStranded(db);
  expect(await spawnArm(db)).toHaveLength(1);
  // A re-staff: the later command speaks for the ticket, and it has not failed. Its `ts` is the
  // failed one's, so only the rowid tie-break can tell them apart — a ULID sorts by its random
  // suffix within a millisecond, which made this arm flicker before the view ordered on rowid.
  unwrap(
    await seedRows(db, {
      commands: [
        {
          id: "cmd-0-sorts-before-cmd-1",
          ts: 1,
          type: "session.spawn",
          payload_json: JSON.stringify({
            session_id: "S-2",
            agent_id: SPINE_SEED.agentId,
            ticket_id: "ticket-1",
          }),
          state: "pending",
        },
      ],
    }),
  );
  expect(await spawnArm(db)).toEqual([]);
});

test("021 ignores a failed spawn on a ticket that is done, and one carrying no ticket", async () => {
  const db = await dbAt(21);
  unwrap(await seedSpine(db, 12));
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(1, { status: "done" })],
      commands: [
        {
          id: "cmd-done",
          ts: 1,
          type: "session.spawn",
          payload_json: JSON.stringify({
            session_id: "S-1",
            ticket_id: "ticket-1",
          }),
          state: "failed",
        },
        // The operator's own ad-hoc session: no ticket to strand, so no arm (the JOIN drops it).
        {
          id: "cmd-loose",
          ts: 2,
          type: "session.spawn",
          payload_json: JSON.stringify({ session_id: "S-loose" }),
          state: "failed",
        },
      ],
    }),
  );
  expect(await spawnArm(db)).toEqual([]);
});
