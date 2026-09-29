import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import type { HandoffsTable } from "./schema-work.js";
import { getTicketEconomics } from "./repos/work-views.js";
import {
  rawAttentionForTest,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "./testing.js";

// 022_phase_change_handoffs: a phase-boundary hand-off is progress, not a sign the
// ticket was too big, so `v_needs_attention`'s split_candidate arm and `v_ticket_economics`'
// handoff_count stop counting it. Without this, a ticket that crosses three boundaries and hits
// one context ceiling pages its own operator.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;

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

const Sql = z.array(z.object({ sql: z.string() }));
const viewSql = (db: Db, name: string): string =>
  Sql.parse(
    rawOf(db)
      .prepare(
        `SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = '${name}'`,
      )
      .all(),
  )[0]?.sql ?? "";

const splitArm = async (db: Db) =>
  unwrap(await rawAttentionForTest(db)).filter(
    (row) => row.why === "split_candidate",
  );

const handoff = (n: number, reason: string): Insertable<HandoffsTable> => ({
  id: `h-${n}`,
  ticket_id: "ticket-1",
  reason,
  facts_json: "{}",
  packet_path: `.foreman/handoff-${n}.md`,
  packet_hash: "h",
  quality: "full",
  created_at: n,
});

/** A ticket at the default `autosplit.handoff_threshold` of 4, made up of `reasons`. */
async function seedHandoffs(db: Db, reasons: readonly string[]): Promise<void> {
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(1, { status: "building" })],
      handoffs: reasons.map((reason, i) => handoff(i + 1, reason)),
    }),
  );
}

test("022 on an empty database keeps every other arm byte for byte, and down and up are exact", async () => {
  const at21 = viewSql(await dbAt(21), "v_needs_attention");
  const at22 = viewSql(await dbAt(22), "v_needs_attention");
  // Only the split_candidate arm's count changed: the arms are the same, in the same order.
  const arms = (sql: string) =>
    [...sql.matchAll(/SELECT (?:DISTINCT )?'(\w+)'/g)].map((m) => m[1]);
  expect(arms(at22)).toEqual(arms(at21));
  expect(at22).toContain("h.reason <> 'phase_change'");
  expect(at21).not.toContain("phase_change");

  const economics22 = viewSql(await dbAt(22), "v_ticket_economics");
  expect(economics22).toContain("phase_handoff_count");

  const schema21 = dump(await dbAt(21));
  const schema22 = dump(await dbAt(22));
  expect(schema22).not.toBe(schema21);
  const db = await dbAt(22);
  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(21);
  expect(dump(db)).toBe(schema21);
  unwrap(await migrateUp(db, { to: 22 }));
  expect(await version(db)).toBe(22);
  expect(dump(db)).toBe(schema22);
});

test("022 on a seeded database: four phase boundaries stop paging the operator, and down pages again", async () => {
  const db = await dbAt(21);
  unwrap(await seedSpine(db, 12));
  // Exactly the shape the spike warned about, one worse: every hand-off is normal progress.
  await seedHandoffs(db, [
    "phase_change",
    "phase_change",
    "phase_change",
    "phase_change",
  ]);
  expect(await splitArm(db)).toEqual([
    { why: "split_candidate", ref: "ticket-1", ticket_id: "ticket-1" },
  ]);

  unwrap(await migrateUp(db, { to: 22 }));
  expect(await splitArm(db)).toEqual([]);
  expect(unwrap(await getTicketEconomics(db, "ticket-1"))).toMatchObject({
    handoff_count: 0,
    phase_handoff_count: 4,
  });

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(21);
  expect(await splitArm(db)).toEqual([
    { why: "split_candidate", ref: "ticket-1", ticket_id: "ticket-1" },
  ]);
  // The rows themselves are untouched by either direction.
  expect(
    z
      .array(z.object({ n: z.number() }))
      .parse(rawOf(db).prepare("SELECT count(*) AS n FROM handoffs").all())[0]
      ?.n,
  ).toBe(4);
});

test("022 still pages when the ceilings alone reach the threshold", async () => {
  const db = await dbAt(22);
  unwrap(await seedSpine(db, 12));
  await seedHandoffs(db, [
    "context_ceiling",
    "turn_ceiling",
    "budget",
    "session_death",
  ]);
  expect(await splitArm(db)).toEqual([
    { why: "split_candidate", ref: "ticket-1", ticket_id: "ticket-1" },
  ]);
  expect(unwrap(await getTicketEconomics(db, "ticket-1"))).toMatchObject({
    handoff_count: 4,
    phase_handoff_count: 0,
  });
});

test("022 counts a mixed chain by its ceilings only: three boundaries plus one ceiling is not a split", async () => {
  const db = await dbAt(22);
  unwrap(await seedSpine(db, 12));
  await seedHandoffs(db, [
    "phase_change",
    "phase_change",
    "phase_change",
    "context_ceiling",
  ]);
  expect(await splitArm(db)).toEqual([]);
  expect(unwrap(await getTicketEconomics(db, "ticket-1"))).toMatchObject({
    handoff_count: 1,
    phase_handoff_count: 3,
    // Nothing is lost: the total is still the ticket's whole hand-off chain.
    sessions: 0,
  });
});
