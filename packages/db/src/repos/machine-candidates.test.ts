import { afterEach, beforeEach, expect, test } from "vitest";
import { gateDb, seedRows, unwrap } from "../testing.js";
import { exec, gateRow } from "./fixtures.js";
import { listMachineCandidates } from "./machine-candidates.js";

// The machine-step sweep's read, on a real temp SQLite file: tickets resting where a
// gate decides, with no gate of theirs running, by updated_at then id, keyset-paged.

let t: Awaited<ReturnType<typeof gateDb>>;
beforeEach(async () => {
  t = await gateDb([
    "code_review", // 1: rests
    "plan_review", // 2: rests
    "qa_harness", // 3: rests
    "code_review", // 4: a gate still running
    "building", // 5: no gate decides it
    "review_fix", // 6: no gate decides it
  ]);
  for (const [n, at] of [
    [1, 300],
    [2, 100],
    [3, 200],
    [4, 50],
  ] as const) {
    exec(
      t.db,
      `UPDATE tickets SET updated_at = ${at} WHERE id = 'ticket-${n}'`,
    );
  }
  unwrap(
    await seedRows(t.db, {
      gates: [
        gateRow("g-done", { ticket_id: "ticket-1", state: "passed" }),
        gateRow("g-run", { ticket_id: "ticket-4" }),
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const ids = async (
  limit: number,
  after: { updated_at: number; id: string } | null,
) =>
  unwrap(await listMachineCandidates(t.db, { limit, after })).map((c) => c.id);

test("resting tickets only, oldest update first", async () => {
  expect(
    unwrap(await listMachineCandidates(t.db, { limit: 10, after: null })),
  ).toEqual([
    { id: "ticket-2", status: "plan_review", updated_at: 100 },
    { id: "ticket-3", status: "qa_harness", updated_at: 200 },
    { id: "ticket-1", status: "code_review", updated_at: 300 },
  ]);
});

test("paged by (updated_at, id): each page carries on after the last, ties broken by id", async () => {
  exec(t.db, "UPDATE tickets SET updated_at = 100 WHERE id = 'ticket-3'");
  expect(await ids(2, null)).toEqual(["ticket-2", "ticket-3"]);
  expect(await ids(2, { updated_at: 100, id: "ticket-2" })).toEqual([
    "ticket-3",
    "ticket-1",
  ]);
  expect(await ids(2, { updated_at: 100, id: "ticket-3" })).toEqual([
    "ticket-1",
  ]);
  expect(await ids(2, { updated_at: 300, id: "ticket-1" })).toEqual([]);
});

test("a bad query is refused", async () => {
  for (const q of [
    { limit: 0, after: null },
    { limit: 1_001, after: null },
    { limit: 1, after: { updated_at: 1, id: "" } },
  ]) {
    expect(
      await listMachineCandidates(t.db, q),
      JSON.stringify(q),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  }
});
