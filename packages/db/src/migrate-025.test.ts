import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp } from "./migrate.js";
import {
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "./testing.js";

// 025_stale_holder: the `stale_session` arm reads `watchdog.silent_ms` instead of a
// hard-coded 1800000, so the arm fires exactly when staffing's release is available. The view's
// clock is SQLite's own `unixepoch()`, not the injected one, so every silence here is measured
// against the wall clock the view will use.
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

/** The spine's session, live and last heard from `silentFor` ms ago on the wall clock. */
const silentFor = (db: Db, ms: number): void => {
  raw(db)
    .prepare(
      "UPDATE sessions SET state = 'running', last_event_at = ? WHERE id = ?",
    )
    .run(Date.now() - ms, SPINE_SEED.sessionId);
};

const setSilentMs = (db: Db, value: number | null): void => {
  if (value === null) {
    raw(db)
      .prepare("DELETE FROM settings WHERE key = 'watchdog.silent_ms'")
      .run();
    return;
  }
  raw(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('watchdog.silent_ms', ?, 1) " +
        "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(String(value));
};

const stale = (db: Db): string[] =>
  attention(db).filter((row) => row.startsWith("stale_session:"));

const STALE = `stale_session:${SPINE_SEED.sessionId}`;

test("025 on an empty database moves the arm onto watchdog.silent_ms", async () => {
  const db = await dbAt(24);
  unwrap(await seedSpine(db, 24));
  silentFor(db, 20 * MINUTE);

  // 024: twenty minutes is inside the hard-coded thirty, and lowering the setting changes nothing.
  expect(stale(db)).toEqual([]);
  setSilentMs(db, 10 * MINUTE);
  expect(stale(db)).toEqual([]);

  unwrap(await migrateUp(db, { to: 25 }));
  expect(stale(db)).toEqual([STALE]);

  // And back up: a session inside the operator's window is not stale.
  setSilentMs(db, 45 * MINUTE);
  expect(stale(db)).toEqual([]);
});

test("025 keeps the thirty minutes when no row is set", async () => {
  const db = await dbAt(24);
  unwrap(await seedSpine(db, 24));
  setSilentMs(db, null);
  silentFor(db, 45 * MINUTE);
  unwrap(await migrateUp(db, { to: 25 }));
  // coalesce: a deleted setting must not silence the arm, only staffing's release (which refuses
  // instead, so the two failure modes stay on the safe side of their own decision).
  expect(stale(db)).toEqual([STALE]);
});

test("025 on a seeded database leaves every other arm exactly as it was", async () => {
  const db = await dbAt(24);
  unwrap(await seedSpine(db, 24));
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(1, { status: "prioritized" }),
        ticketRow(2, { status: "building" }),
      ],
    }),
  );
  raw(db)
    .prepare(
      "INSERT INTO messages (id, ts, from_kind, from_id, to_kind, to_id, kind, subject, body_md, ticket_id) " +
        "VALUES ('m-1', 1, 'human', 'operator', 'agent', ?, 'note', 'read me', 'read me', 'ticket-2')",
    )
    .run(SPINE_SEED.agentId);
  silentFor(db, 45 * MINUTE);

  const before = attention(db);
  expect(before).toContain(STALE);
  expect(before).toContain("unstaffed_ready:ticket-1");
  expect(before).toContain("unread_message:m-1");

  unwrap(await migrateUp(db, { to: 25 }));
  expect(attention(db)).toEqual(before);

  // Down puts the hard-coded threshold back: the setting stops being read.
  unwrap(await migrateDown(db));
  setSilentMs(db, 10 * MINUTE);
  silentFor(db, 20 * MINUTE);
  expect(stale(db)).toEqual([]);
  expect(attention(db)).toEqual(before.filter((row) => row !== STALE));
});
