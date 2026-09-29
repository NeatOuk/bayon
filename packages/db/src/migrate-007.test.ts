import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { getSettings } from "./repos/config.js";
import { listTicketFindings, listTicketGates } from "./repos/work-views.js";
import type { FindingsTable, GatesTable } from "./schema-work.js";
import {
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "./testing.js";

// 007_gates: gates and findings rebuilt with state/status CHECKs, the resolve/waive
// columns, sessions.gate_id and fallback_from_runner_id, runners.conformance_json, two indexes and
// the M3 settings.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const raw = (db: Db) => unwrap(internalsOf(db)).raw;

/** The schema in a fixed order, without rootpage (a page number, not a definition). */
const dump = (db: Db): string =>
  JSON.stringify(
    raw(db)
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      )
      .all(),
  );

const names = (db: Db, type: "index" | "table", table: string): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = ? AND tbl_name = ? ORDER BY name",
        )
        .pluck()
        .all(type, table),
    );

const SETTINGS = [
  "gates.wall_clock_ms",
  "gates.blocking_severities",
  "gates.base_drift",
  "executors.untrusted_roles",
];

const gate = (
  id: string,
  state: GatesTable["state"],
  o: Partial<Insertable<GatesTable>> = {},
): Insertable<GatesTable> => ({
  id,
  ticket_id: "ticket-1",
  kind: "code_review",
  state,
  subject_kind: "diff",
  subject_ref: "main..head",
  ...o,
});
const finding = (
  id: string,
  o: Partial<Insertable<FindingsTable>> = {},
): Insertable<FindingsTable> => ({
  id,
  gate_id: "g-failed",
  severity: "major",
  summary: id,
  created_at: 0,
  ...o,
});

/** A ticket's gates in every state 007 allows, and findings open and resolved. */
async function seedGates(db: Db): Promise<void> {
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(1, { status: "building" })],
      gates: [
        gate("g-failed", "failed", {
          evidence_json: '{"reason":"timeout"}',
          started_at: 1,
          decided_at: 2,
        }),
        gate("g-running", "running", { attempt: 2, started_at: 3 }),
        gate("g-passed", "passed", { kind: "plan_review", decided_at: 4 }),
        gate("g-waived", "waived", {
          kind: "ce_review",
          waived_by: "operator",
          waive_reason: "not applicable",
        }),
      ],
      findings: [
        finding("f-open"),
        finding("f-resolved", { status: "resolved", resolution_note: "fixed" }),
      ],
    }),
  );
}

const gatesOf = async (db: Db) => unwrap(await listTicketGates(db, "ticket-1"));
const findingsOf = async (db: Db) =>
  unwrap(await listTicketFindings(db, "ticket-1"));

test("007 on an empty database: its indexes, its columns and the M3 settings", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 7 }));
  expect(names(db, "index", "gates")).toEqual(
    expect.arrayContaining(["gates_attempt_idx", "gates_state_idx"]),
  );
  expect(names(db, "index", "findings")).toContain("findings_gate_status_idx");
  const settings = unwrap(await getSettings(db, SETTINGS));
  expect(Object.fromEntries(settings)).toEqual({
    "gates.wall_clock_ms": 900_000,
    "gates.blocking_severities": ["blocker", "major"],
    "gates.base_drift": "fail",
    "executors.untrusted_roles": ["investigator"],
  });
  // No role binding is seeded (Invariant 1).
  expect(
    raw(db).prepare("SELECT count(*) FROM role_bindings").pluck().get(),
  ).toBe(0);
});

test("007 on a seeded database keeps every gate and finding, and an operator's setting", async () => {
  const db = await dbAt(6);
  unwrap(await seedSpine(db, 6));
  await seedGates(db);
  unwrap(
    await seedRows(db, {
      settings: [
        { key: "gates.base_drift", value_json: '"warn"', updated_at: 0 },
      ],
    }),
  );
  const gates = await gatesOf(db);
  const findings = await findingsOf(db);
  unwrap(await migrateUp(db, { to: 7 }));
  expect(await gatesOf(db)).toEqual(gates);
  expect(await findingsOf(db)).toEqual(
    findings.map((f) => ({
      ...f,
      resolved_by: null,
      resolved_at: null,
      waived_by: null,
      waive_reason: null,
    })),
  );
  const session = raw(db)
    .prepare(
      "SELECT gate_id, fallback_from_runner_id FROM sessions WHERE id = ?",
    )
    .get(SPINE_SEED.sessionId);
  expect(session).toEqual({ gate_id: null, fallback_from_runner_id: null });
  const drift = unwrap(await getSettings(db, ["gates.base_drift"]));
  expect(drift.get("gates.base_drift")).toBe("warn");
});

test("the CHECKs refuse a gate state and a finding status outside their sets", async () => {
  const db = await dbAt(7);
  unwrap(await seedSpine(db, 7));
  await seedGates(db);
  const insertGate = raw(db).prepare(
    "INSERT INTO gates (id, ticket_id, kind, state, subject_kind, subject_ref) VALUES (?, 'ticket-1', 'code_review', ?, 'diff', 'HEAD')",
  );
  expect(() => insertGate.run("g-queued", "queued")).toThrow(
    /CHECK constraint failed/,
  );
  const setStatus = raw(db).prepare(
    "UPDATE findings SET status = ? WHERE id = 'f-open'",
  );
  expect(() => setStatus.run("fixed")).toThrow(/CHECK constraint failed/);
  setStatus.run("waived");
});

test("sessions.gate_id names a gate and fallback_from_runner_id a runner", async () => {
  const db = await dbAt(7);
  unwrap(await seedSpine(db, 7));
  await seedGates(db);
  const set = (column: string, value: string) =>
    raw(db)
      .prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`)
      .run(value, SPINE_SEED.sessionId);
  expect(() => set("gate_id", "no-such-gate")).toThrow(/FOREIGN KEY/);
  expect(() => set("fallback_from_runner_id", "no-such-runner")).toThrow(
    /FOREIGN KEY/,
  );
  set("gate_id", "g-running");
  set("fallback_from_runner_id", SPINE_SEED.runnerId);
});

test("007 refuses a database holding a gate state outside its set, and applies nothing", async () => {
  const db = await dbAt(6);
  unwrap(await seedSpine(db, 6));
  unwrap(await seedRows(db, { tickets: [ticketRow(1)] }));
  raw(db)
    .prepare(
      "INSERT INTO gates (id, ticket_id, kind, state, subject_kind, subject_ref) VALUES ('g-1', 'ticket-1', 'code_review', 'pending', 'diff', 'HEAD')",
    )
    .run();
  const before = dump(db);
  expect(await migrateUp(db, { to: 7 })).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(unwrap(await migrationStatus(db)).applied.at(-1)?.version).toBe(6);
  expect(dump(db)).toBe(before);
  expect(raw(db).prepare("SELECT state FROM gates").pluck().all()).toEqual([
    "pending",
  ]);
});

test("007 down restores 006's schema byte for byte and keeps the rows; up again reapplies", async () => {
  const at6 = await dbAt(6);
  const db = await dbAt(7);
  unwrap(await seedSpine(db, 7));
  await seedGates(db);
  raw(db)
    .prepare(
      "UPDATE findings SET status = 'waived', waived_by = 'operator', waive_reason = 'noise' WHERE id = 'f-open'",
    )
    .run();
  raw(db).prepare("UPDATE sessions SET gate_id = 'g-running'").run();
  const gates = await gatesOf(db);
  const findings = await findingsOf(db);

  unwrap(await migrateDown(db));
  expect(dump(db)).toBe(dump(at6));
  expect(await gatesOf(db)).toEqual(gates);
  const added = new Set([
    "resolved_by",
    "resolved_at",
    "waived_by",
    "waive_reason",
  ]);
  expect(await findingsOf(db)).toEqual(
    findings.map((f) =>
      Object.fromEntries(Object.entries(f).filter(([key]) => !added.has(key))),
    ),
  );
  expect(unwrap(await getSettings(db, SETTINGS)).size).toBe(0);

  unwrap(await migrateUp(db, { to: 7 }));
  expect((await findingsOf(db)).map((f) => f.status)).toEqual([
    "waived",
    "resolved",
  ]);
});
