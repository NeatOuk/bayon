import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import { tempDb, unwrap } from "../testing.js";
import { getBudgetCap, setBudgetCap } from "./budget.js";
import { DAILY_CAP_KEY } from "./fleet-overview.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));

const row = () =>
  raw
    .prepare("SELECT value_json, updated_at FROM settings WHERE key = ?")
    .get(DAILY_CAP_KEY) as
    { value_json: string; updated_at: number } | undefined;

test("the seeded cap is null", async () => {
  expect(unwrap(await getBudgetCap(t.db))).toBeNull();
});

test("setBudgetCap stores a cap, stamped by the clock, and getBudgetCap reads it back", async () => {
  await clock.advance(1_000);
  expect(unwrap(await setBudgetCap(t.db, 40, "operator"))).toBe(40);
  expect(unwrap(await getBudgetCap(t.db))).toBe(40);
  expect(row()).toEqual({ value_json: "40", updated_at: T0 + 1_000 });
});

test("setBudgetCap(null) clears the cap", async () => {
  unwrap(await setBudgetCap(t.db, 40, "operator"));
  await clock.advance(1_000);
  expect(unwrap(await setBudgetCap(t.db, null, "operator"))).toBeNull();
  expect(unwrap(await getBudgetCap(t.db))).toBeNull();
  expect(row()?.updated_at).toBe(T0 + 2_000);
});

test("zero is a valid cap", async () => {
  expect(unwrap(await setBudgetCap(t.db, 0, "operator"))).toBe(0);
  expect(unwrap(await getBudgetCap(t.db))).toBe(0);
});

test.each([
  ["a negative number", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a string", "40" as unknown as number],
])("rejects %s and leaves the stored cap untouched", async (_name, bad) => {
  unwrap(await setBudgetCap(t.db, 12, "operator"));
  expect(await setBudgetCap(t.db, bad, "operator")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(unwrap(await getBudgetCap(t.db))).toBe(12);
});

test("a missing settings row is no cap; a malformed one is an internal error", async () => {
  const fresh = unwrap(await tempDb(new FakeClock(T0)));
  const { raw: freshRaw } = unwrap(internalsOf(fresh.db));
  freshRaw.prepare("DELETE FROM settings WHERE key = ?").run(DAILY_CAP_KEY);
  expect(unwrap(await getBudgetCap(fresh.db))).toBeNull();
  for (const bad of ['"forty"', "-1", "{"]) {
    freshRaw
      .prepare(
        "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(DAILY_CAP_KEY, bad, T0);
    expect(await getBudgetCap(fresh.db)).toMatchObject({
      ok: false,
      error: { class: "internal" },
    });
  }
  fresh.cleanup();
});

const auditRows = () =>
  raw
    .prepare(
      "SELECT actor, action, target_kind, target_id, payload_json FROM audit_log WHERE action = 'budget.put' ORDER BY id",
    )
    .all() as {
    actor: string;
    action: string;
    target_kind: string | null;
    target_id: string | null;
    payload_json: string | null;
  }[];

test("a cap change writes one audit row carrying who, and both values", async () => {
  const before = auditRows().length;
  unwrap(await setBudgetCap(t.db, 22, "operator"));
  unwrap(await setBudgetCap(t.db, 100, "operator"));
  const rows = auditRows();
  expect(rows).toHaveLength(before + 2);
  expect(rows.at(-1)).toMatchObject({
    actor: "operator",
    action: "budget.put",
    target_kind: "setting",
    target_id: DAILY_CAP_KEY,
  });
  // The raise this ticket was filed over: 22 -> 100 must be readable from the row itself.
  expect(JSON.parse(rows.at(-1)?.payload_json ?? "null")).toMatchObject({
    from: 22,
    to: 100,
  });
});

test("clearing the cap is audited too, with null as the new value", async () => {
  unwrap(await setBudgetCap(t.db, 50, "operator"));
  const before = auditRows().length;
  unwrap(await setBudgetCap(t.db, null, "operator"));
  const rows = auditRows();
  expect(rows).toHaveLength(before + 1);
  expect(JSON.parse(rows.at(-1)?.payload_json ?? "null")).toMatchObject({
    from: 50,
    to: null,
  });
});

test("the same cap again writes neither row: an unchanged value is not a change", async () => {
  unwrap(await setBudgetCap(t.db, 77, "operator"));
  const before = auditRows().length;
  const stamped = row()?.updated_at;
  await clock.advance(5_000);
  unwrap(await setBudgetCap(t.db, 77, "operator"));
  expect(auditRows()).toHaveLength(before);
  expect(row()?.updated_at).toBe(stamped);
});

test("a rejected cap writes neither the setting nor an audit row", async () => {
  unwrap(await setBudgetCap(t.db, 30, "operator"));
  const before = auditRows().length;
  expect(await setBudgetCap(t.db, -1, "operator")).toMatchObject({ ok: false });
  expect(await setBudgetCap(t.db, 10, " ")).toMatchObject({ ok: false });
  expect(auditRows()).toHaveLength(before);
  expect(unwrap(await getBudgetCap(t.db))).toBe(30);
});
