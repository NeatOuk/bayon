import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import type { Db } from "../connection.js";
import type { FindingsTable, GatesTable } from "../schema-work.js";
import {
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import {
  getGate,
  getRoleBinding,
  listGateFindings,
  listGatesInState,
  listRoleBindings,
} from "./gates.js";

const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const gate = (
  id: string,
  state: GatesTable["state"],
  started_at: number | null,
  attempt = 1,
): Insertable<GatesTable> => ({
  id,
  ticket_id: "ticket-1",
  kind: "code_review",
  state,
  attempt,
  subject_kind: "diff",
  subject_ref: "main..head",
  started_at,
});
const finding = (
  id: string,
  gate_id: string,
  created_at: number,
  o: Partial<Insertable<FindingsTable>> = {},
): Insertable<FindingsTable> => ({
  id,
  gate_id,
  severity: "major",
  summary: id,
  created_at,
  ...o,
});

async function seeded(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 7));
  unwrap(
    await seedRows(t.db, {
      tickets: [ticketRow(1)],
      role_bindings: [
        {
          role: "plan_reviewer",
          runner_id: SPINE_SEED.runnerId,
          updated_at: 0,
        },
        {
          role: "code_reviewer",
          runner_id: SPINE_SEED.runnerId,
          fallback_runner_id: SPINE_SEED.runnerId,
          updated_at: 0,
        },
      ],
      gates: [
        gate("g-late", "running", 300, 1),
        gate("g-early", "running", 100, 2),
        gate("g-done", "passed", 50, 3),
      ],
      findings: [
        finding("f-2", "g-late", 20),
        finding("f-1", "g-late", 10, {
          status: "resolved",
          resolved_by: "operator",
        }),
        finding("f-3", "g-late", 20, {
          status: "waived",
          waive_reason: "noise",
        }),
        finding("f-other", "g-early", 5),
      ],
    }),
  );
  return t.db;
}

test("getGate: the row, or not_found", async () => {
  const db = await seeded();
  expect(unwrap(await getGate(db, "g-done"))).toMatchObject({
    id: "g-done",
    state: "passed",
  });
  expect(await getGate(db, "nope")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("listGateFindings: one gate's findings oldest first, narrowed by status", async () => {
  const db = await seeded();
  const ids = async (status?: "open" | "resolved" | "waived") =>
    unwrap(
      await listGateFindings(
        db,
        "g-late",
        status === undefined ? {} : { status },
      ),
    ).map((f) => f.id);
  expect(await ids()).toEqual(["f-1", "f-2", "f-3"]);
  expect(await ids("open")).toEqual(["f-2"]);
  expect(await ids("resolved")).toEqual(["f-1"]);
  expect(await ids("waived")).toEqual(["f-3"]);
});

test("listGatesInState: longest-running first", async () => {
  const db = await seeded();
  const ids = async (state: GatesTable["state"]) =>
    unwrap(await listGatesInState(db, state)).map((g) => g.id);
  expect(await ids("running")).toEqual(["g-early", "g-late"]);
  expect(await ids("passed")).toEqual(["g-done"]);
  expect(await ids("waived")).toEqual([]);
});

test("role bindings: one by role, null when unbound, and all by role", async () => {
  const db = await seeded();
  expect(unwrap(await getRoleBinding(db, "code_reviewer"))).toMatchObject({
    runner_id: SPINE_SEED.runnerId,
    fallback_runner_id: SPINE_SEED.runnerId,
  });
  expect(unwrap(await getRoleBinding(db, "builder"))).toBeNull();
  expect(unwrap(await listRoleBindings(db)).map((b) => b.role)).toEqual([
    "code_reviewer",
    "plan_reviewer",
  ]);
});
