import { afterEach, beforeEach, expect, test } from "vitest";
import {
  gateDb,
  seedRows,
  ticketRow,
  unwrap,
  type TempDb,
} from "../testing.js";
import { gateRow } from "./fixtures.js";
import { listGates, type GatesQuery } from "./gates.js";

// GET /gates?project=: a gate's project is its ticket's. The state, latest and cursor
// filters work inside a project as across the fleet, and one project's gates never show under
// another's.

let t: TempDb;
beforeEach(async () => {
  // ticket-1 has no project; 2 and 3 are shop's, 4 is blog's.
  t = await gateDb(["code_review"]);
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "shop", name: "shop", kind: "single" },
        { id: "blog", name: "blog", kind: "single" },
      ],
      tickets: [
        ticketRow(2, { status: "code_review", workspace_id: "shop" }),
        ticketRow(3, { status: "code_review", workspace_id: "shop" }),
        ticketRow(4, { status: "code_review", workspace_id: "blog" }),
      ],
      gates: [
        gateRow("fleet", { state: "failed", started_at: 5 }),
        gateRow("s1", {
          ticket_id: "ticket-2",
          state: "failed",
          started_at: 10,
        }),
        gateRow("s2", {
          ticket_id: "ticket-2",
          attempt: 2,
          state: "running",
          started_at: 20,
        }),
        gateRow("s3", {
          ticket_id: "ticket-3",
          kind: "plan_review",
          state: "passed",
          started_at: 30,
        }),
        gateRow("b1", {
          ticket_id: "ticket-4",
          state: "failed",
          started_at: 40,
        }),
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const ids = async (q: Partial<GatesQuery> = {}) =>
  unwrap(await listGates(t.db, { latest: true, limit: 100, ...q })).rows.map(
    (r) => r.id,
  );

test("one project's gates only, by their ticket's project; another's and a fleet ticket's never", async () => {
  expect(await ids({ workspace_id: "shop" })).toEqual(["s3", "s2"]);
  expect(await ids({ workspace_id: "blog" })).toEqual(["b1"]);
  expect(await ids()).toEqual(["b1", "s3", "s2", "fleet"]);
  expect(await ids({ workspace_id: "nowhere" })).toEqual([]);
});

test("state and latest filter within the project", async () => {
  expect(
    await ids({ workspace_id: "shop", states: ["running", "failed"] }),
  ).toEqual(["s2"]);
  expect(await ids({ workspace_id: "shop", latest: false })).toEqual([
    "s3",
    "s2",
    "s1",
  ]);
  expect(
    await ids({ workspace_id: "shop", ticket_id: "ticket-4", latest: false }),
  ).toEqual([]);
});

test("the keyset cursor pages within the project", async () => {
  const first = unwrap(
    await listGates(t.db, { workspace_id: "shop", latest: false, limit: 2 }),
  );
  expect(first.rows.map((r) => r.id)).toEqual(["s3", "s2"]);
  expect(first).toMatchObject({
    hasMore: true,
    nextCursor: { started_at: 20, id: "s2" },
  });
  const rest = unwrap(
    await listGates(t.db, {
      workspace_id: "shop",
      latest: false,
      limit: 2,
      after: first.nextCursor ?? undefined,
    }),
  );
  expect(rest.rows.map((r) => r.id)).toEqual(["s1"]);
  expect(rest).toMatchObject({ hasMore: false, nextCursor: null });
});
