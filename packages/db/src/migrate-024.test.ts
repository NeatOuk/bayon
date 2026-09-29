import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import type { GatesTable } from "./schema-work.js";
import { seedRows, seedSpine, tempDb, ticketRow, unwrap } from "./testing.js";

// 024_lint_check: the `lint_check` gate kind and its default-off switch. The kind is a
// CHECK on `gates.kind`, which SQLite widens only by rebuilding the table -- so the interesting part
// of this migration is what the rebuild must not lose: 023's `round` column and index, the findings
// of every gate, and `sessions.gate_id`, which points at gates and would make DROP TABLE's implicit
// DELETE an immediate foreign-key violation if it were left in place.
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

const indexes = (db: Db, table: string): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? ORDER BY name",
        )
        .pluck()
        .all(table),
    );

const setting = (db: Db, key: string): string | undefined =>
  z
    .union([z.string(), z.undefined()])
    .parse(
      raw(db)
        .prepare("SELECT value_json FROM settings WHERE key = ?")
        .pluck()
        .get(key),
    );

/** Inserts a gate row with raw SQL, so the CHECK is what answers rather than a repo function. */
function insertGate(db: Db, id: string, kind: string): void {
  raw(db)
    .prepare(
      "INSERT INTO gates (id, ticket_id, kind, state, subject_kind, subject_ref) " +
        "VALUES (?, 'ticket-1', ?, 'running', 'diff', 'unpinned')",
    )
    .run(id, kind);
}

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

/**
 * A ticket with two rounds of gates, a finding on one of them, and a reviewer session linked to a
 * gate -- the three things the rebuild has to carry across.
 */
async function seedGates(db: Db): Promise<void> {
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(1, { status: "code_review" })],
      gates: [
        gate("g-code-1", { attempt: 1, round: 1, state: "failed" }),
        gate("g-code-2", { attempt: 2, round: 2 }),
        gate("g-parity", { kind: "parity_check", attempt: 1, round: 2 }),
      ],
    }),
  );
  raw(db)
    .prepare(
      "INSERT INTO findings (id, gate_id, severity, summary, status, created_at) " +
        "VALUES ('f-1', 'g-code-1', 'blocker', 'a blocker', 'open', 1)",
    )
    .run();
  raw(db)
    .prepare(
      "UPDATE sessions SET gate_id = 'g-code-2' WHERE id = 'session-fixture'",
    )
    .run();
}

const gateRounds = (db: Db): Record<string, number> =>
  Object.fromEntries(
    z
      .array(z.object({ id: z.string(), round: z.int() }))
      .parse(raw(db).prepare("SELECT id, round FROM gates ORDER BY id").all())
      .map((r) => [r.id, r.round]),
  );

const sessionGate = (db: Db): unknown =>
  raw(db)
    .prepare("SELECT gate_id FROM sessions WHERE id = 'session-fixture'")
    .pluck()
    .get();

test("024 on an empty database admits lint_check and seeds the switch off", async () => {
  const db = await dbAt(23);
  unwrap(await seedSpine(db, 23));
  unwrap(
    await seedRows(db, { tickets: [ticketRow(1, { status: "code_review" })] }),
  );
  // Before: the kind is outside 007's CHECK.
  expect(() => insertGate(db, "g-before", "lint_check")).toThrow(
    /CHECK constraint failed/,
  );

  unwrap(await migrateUp(db, { to: 24 }));
  insertGate(db, "g-after", "lint_check");
  expect(
    raw(db)
      .prepare("SELECT kind FROM gates WHERE id = 'g-after'")
      .pluck()
      .get(),
  ).toBe("lint_check");
  // Off is the safe state (020's reason): with it on and no lint job seeded, every ticket stops in
  // code_review behind a gate nobody can decide.
  expect(setting(db, "gates.lint_check")).toBe("false");
  // An unknown kind is still refused: the CHECK was widened, not dropped.
  expect(() => insertGate(db, "g-bogus", "vibe_check")).toThrow(
    /CHECK constraint failed/,
  );
});

test("024 keeps an operator's own value for the switch", async () => {
  const db = await dbAt(23);
  raw(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('gates.lint_check', 'true', 1)",
    )
    .run();
  unwrap(await migrateUp(db, { to: 24 }));
  expect(setting(db, "gates.lint_check")).toBe("true");
});

test("024 on a seeded database keeps rounds, findings, indexes and the session link", async () => {
  const db = await dbAt(23);
  unwrap(await seedSpine(db, 23));
  await seedGates(db);

  unwrap(await migrateUp(db, { to: 24 }));

  expect(columns(db)).toContain("round");
  expect(gateRounds(db)).toEqual({
    "g-code-1": 1,
    "g-code-2": 2,
    "g-parity": 2,
  });
  expect(indexes(db, "gates")).toEqual([
    "gates_attempt_idx",
    "gates_round_idx",
    "gates_state_idx",
    // SQLite's own, for the PRIMARY KEY and the UNIQUE: naming them pins that the rebuild kept
    // both constraints, not only the explicit indexes.
    "sqlite_autoindex_gates_1",
    "sqlite_autoindex_gates_2",
  ]);
  expect(indexes(db, "findings")).toContain("findings_gate_status_idx");
  expect(raw(db).prepare("SELECT count(*) FROM findings").pluck().get()).toBe(
    1,
  );
  // The link a reviewer session holds survives the parking that made the drop legal at all.
  expect(sessionGate(db)).toBe("g-code-2");
  expect(
    raw(db)
      .prepare(
        "SELECT count(*) FROM sqlite_schema WHERE name LIKE '\\_%' ESCAPE '\\'",
      )
      .pluck()
      .get(),
  ).toBe(1); // _migrations alone: every scratch table is dropped
});

/** `sqlite_schema` for one table: the stored CREATE text and every index on it. */
const schemaOf = (
  db: Db,
  table: string,
): { sql: string; indexes: string[] } => ({
  sql: z
    .string()
    .parse(
      raw(db)
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
        )
        .pluck()
        .get(table),
    ),
  indexes: indexes(db, table),
});

// The down file's header says "back to 023's schema, byte for byte". Nothing asserted it, and it
// was not true: the rebuild put 023's `round` at column position 7 instead of 18, where ALTER TABLE
// ADD COLUMN leaves it, and dropped `findings`' two trailing comments. Harmless today -- every
// access is by column name -- but an untrue claim in the one file whose whole job is going back.
// Now it is true, and this is what holds it true: a chain that only ever ran up to 023 against a
// chain that went to 024 and back, `sqlite_schema.sql` compared as text.
test("024 down leaves the same schema text a chain that stopped at 023 has", async () => {
  const at23 = await dbAt(23);
  unwrap(await seedSpine(at23, 23));

  const rolled = await dbAt(23);
  unwrap(await seedSpine(rolled, 23));
  await seedGates(rolled);
  unwrap(await migrateUp(rolled, { to: 24 }));
  unwrap(await migrateDown(rolled));

  for (const table of ["gates", "findings"]) {
    expect(schemaOf(rolled, table), table).toEqual(schemaOf(at23, table));
  }
  // And the column positions that text implies, which is what a `SELECT *` consumer would see.
  const positions = (db: Db): string[] =>
    z
      .array(z.string())
      .parse(
        raw(db)
          .prepare("SELECT name FROM pragma_table_info('gates') ORDER BY cid")
          .pluck()
          .all(),
      );
  expect(positions(rolled)).toEqual(positions(at23));
  expect(positions(at23).at(-1)).toBe("round");
});

test("024 down restores 023's schema, drops lint_check gates, and up again re-widens", async () => {
  const db = await dbAt(23);
  unwrap(await seedSpine(db, 23));
  await seedGates(db);
  unwrap(await migrateUp(db, { to: 24 }));
  insertGate(db, "g-lint", "lint_check");
  raw(db)
    .prepare(
      "INSERT INTO findings (id, gate_id, severity, summary, status, created_at) " +
        "VALUES ('f-lint', 'g-lint', 'blocker', 'lint failed', 'open', 1)",
    )
    .run();

  unwrap(await migrateDown(db));
  expect(unwrap(await migrationStatus(db)).applied.at(-1)?.version).toBe(23);
  // A row of a kind the restored CHECK forbids cannot stay; the rest of the ticket's gates do.
  expect(
    raw(db).prepare("SELECT id FROM gates ORDER BY id").pluck().all(),
  ).toEqual(["g-code-1", "g-code-2", "g-parity"]);
  expect(
    raw(db).prepare("SELECT id FROM findings ORDER BY id").pluck().all(),
  ).toEqual(["f-1"]);
  expect(setting(db, "gates.lint_check")).toBeUndefined();
  expect(sessionGate(db)).toBe("g-code-2");
  expect(gateRounds(db)["g-code-2"]).toBe(2);
  expect(() => insertGate(db, "g-again", "lint_check")).toThrow(
    /CHECK constraint failed/,
  );

  unwrap(await migrateUp(db, { to: 24 }));
  insertGate(db, "g-again", "lint_check");
  expect(raw(db).prepare("SELECT count(*) FROM gates").pluck().get()).toBe(4);
});
