import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import type { GatesTable } from "./schema-work.js";
import { seedRows, seedSpine, tempDb, ticketRow, unwrap } from "./testing.js";

// 023_gate_round: `gates.round`, the review round that opened a gate. `attempt` is per
// kind and counts up forever, so it cannot answer "did THIS round open one" — the question that
// keeps a conditional gate's requirement from being satisfied by an earlier round's evidence.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const raw = (db: Db) => unwrap(internalsOf(db)).raw;

const columns = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare("SELECT name FROM pragma_table_info('gates')")
        .pluck()
        .all(),
    );

const indexes = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'gates' ORDER BY name",
        )
        .pluck()
        .all(),
    );

const gate = (
  id: string,
  o: Partial<Insertable<GatesTable>> = {},
): Insertable<GatesTable> => ({
  id,
  ticket_id: "ticket-1",
  kind: "code_review",
  state: "passed",
  subject_kind: "diff",
  subject_ref: "base..head",
  ...o,
});

/** Two rounds' worth of gates, as a ticket that predates the migration holds them. */
async function seedGates(db: Db): Promise<void> {
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(1, { status: "code_review" })],
      gates: [
        gate("g-code-1", { attempt: 1, state: "failed" }),
        gate("g-ce-1", { kind: "ce_review", attempt: 1 }),
        // A retry bumped this one's attempt inside its round: proof that `attempt` is not a round.
        gate("g-code-2", { attempt: 2, state: "failed" }),
        gate("g-code-3", { attempt: 3 }),
        gate("g-parity", { kind: "parity_check", attempt: 1, repo_id: null }),
      ],
    }),
  );
}

const rounds = (db: Db): Record<string, number> =>
  Object.fromEntries(
    z
      .array(z.object({ id: z.string(), round: z.int() }))
      .parse(raw(db).prepare("SELECT id, round FROM gates ORDER BY id").all())
      .map((r) => [r.id, r.round]),
  );

test("023 on an empty database adds gates.round and its index", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 23 }));
  expect(columns(db)).toContain("round");
  expect(indexes(db)).toContain("gates_round_idx");
  // NOT NULL with a default, so every writer that forgets it still writes a usable row.
  const spec = z
    .array(z.object({ notnull: z.int(), dflt_value: z.string() }))
    .parse(
      raw(db)
        .prepare(
          "SELECT \"notnull\", dflt_value FROM pragma_table_info('gates') WHERE name = 'round'",
        )
        .all(),
    );
  expect(spec).toEqual([{ notnull: 1, dflt_value: "1" }]);
});

test("023 on a seeded database backfills every existing gate to round 1", async () => {
  const db = await dbAt(22);
  unwrap(await seedSpine(db, 22));
  await seedGates(db);
  unwrap(await migrateUp(db, { to: 23 }));
  // One round, every gate in it: a ticket that predates the marker behaves exactly as it did, and
  // the first round opened after the migration gets 2. Backfilling from `attempt` would put
  // g-code-3 in round 3 and its own round's ce_review in round 1, which no law could read.
  expect(rounds(db)).toEqual({
    "g-ce-1": 1,
    "g-code-1": 1,
    "g-code-2": 1,
    "g-code-3": 1,
    "g-parity": 1,
  });
});

test("023 down drops the column and the index, and keeps every gate; up again re-adds it", async () => {
  const db = await dbAt(22);
  unwrap(await seedSpine(db, 22));
  await seedGates(db);
  unwrap(await migrateUp(db, { to: 23 }));
  raw(db).prepare("UPDATE gates SET round = 2 WHERE id = 'g-code-3'").run();

  unwrap(await migrateDown(db));
  expect(unwrap(await migrationStatus(db)).applied.at(-1)?.version).toBe(22);
  expect(columns(db)).not.toContain("round");
  expect(indexes(db)).not.toContain("gates_round_idx");
  expect(raw(db).prepare("SELECT count(*) FROM gates").pluck().get()).toBe(5);

  unwrap(await migrateUp(db, { to: 23 }));
  // The marker a run had is not recoverable once it is dropped: up again is the backfill again.
  expect(rounds(db)["g-code-3"]).toBe(1);
});
