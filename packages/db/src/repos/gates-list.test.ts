import { afterEach, beforeEach, expect, test } from "vitest";
import {
  gateDb,
  newSessionInput,
  seedRows,
  unwrap,
  type TempDb,
} from "../testing.js";
import { gateRow } from "./fixtures.js";
import { gateReason } from "./gate-common.js";
import { listGateSessions, listGates } from "./gates.js";
import { factsOf } from "./ticket-facts.js";

// GET /gates' read: states, a ticket, the latest attempt per (ticket, kind, repo),
// newest first by (started_at, id), keyset-paged; and the sessions a gate spawned.

let t: TempDb;
beforeEach(async () => {
  t = await gateDb(["code_review", "code_review", "building"]);
  unwrap(
    await seedRows(t.db, {
      gates: [
        gateRow("a1", { attempt: 1, state: "failed", started_at: 10 }),
        gateRow("a2", { attempt: 2, state: "running", started_at: 20 }),
        gateRow("b1", { kind: "ce_review", state: "passed", started_at: 15 }),
        gateRow("c1", {
          ticket_id: "ticket-2",
          state: "failed",
          started_at: 30,
        }),
        gateRow("d1", {
          ticket_id: "ticket-2",
          kind: "plan_review",
          state: "waived",
          started_at: null,
        }),
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const ids = async (q: Partial<Parameters<typeof listGates>[1]> = {}) =>
  unwrap(await listGates(t.db, { latest: true, limit: 100, ...q })).rows.map(
    (r) => r.id,
  );

test("latest attempts only, newest first; every attempt with latest=false", async () => {
  expect(await ids()).toEqual(["c1", "a2", "b1", "d1"]);
  expect(await ids({ latest: false })).toEqual(["c1", "a2", "b1", "a1", "d1"]);
});

test("filters by state and ticket, and carries the ticket's num, title and status", async () => {
  expect(await ids({ states: ["running", "failed"] })).toEqual(["c1", "a2"]);
  expect(
    await ids({ states: ["failed"], latest: false, ticket_id: "ticket-1" }),
  ).toEqual(["a1"]);
  const [row] = unwrap(await listGates(t.db, { latest: true, limit: 1 })).rows;
  expect(row).toMatchObject({
    id: "c1",
    ticket_num: 2,
    ticket_title: "ticket 2",
    ticket_status: "code_review",
  });
});

test("pages by keyset", async () => {
  const first = unwrap(await listGates(t.db, { latest: false, limit: 2 }));
  expect(first.rows.map((r) => r.id)).toEqual(["c1", "a2"]);
  expect(first).toMatchObject({
    hasMore: true,
    nextCursor: { started_at: 20, id: "a2" },
  });
  const rest = unwrap(
    await listGates(t.db, {
      latest: false,
      limit: 5,
      after: first.nextCursor ?? undefined,
    }),
  );
  expect(rest.rows.map((r) => r.id)).toEqual(["b1", "a1", "d1"]);
  expect(rest).toMatchObject({ hasMore: false, nextCursor: null });
});

test("a gate's sessions, newest first, and none for no gates", async () => {
  unwrap(
    await seedRows(t.db, {
      sessions: [
        {
          ...newSessionInput(),
          id: "S-r1",
          state: "exited",
          gate_id: "a1",
          created_at: 1,
        },
        {
          ...newSessionInput(),
          id: "S-r2",
          state: "running",
          gate_id: "a2",
          created_at: 2,
        },
      ],
    }),
  );
  expect(unwrap(await listGateSessions(t.db, ["a1", "a2", "b1"]))).toEqual([
    { gate_id: "a2", session_id: "S-r2" },
    { gate_id: "a1", session_id: "S-r1" },
  ]);
  expect(unwrap(await listGateSessions(t.db, []))).toEqual([]);
});

test("gateReason reads a decided gate's reason, and null otherwise", () => {
  expect(gateReason('{"reason":"timeout"}')).toBe("timeout");
  expect(gateReason(null)).toBeNull();
  expect(gateReason("not json")).toBeNull();
  expect(gateReason('{"reason":"nonsense"}')).toBeNull();
});

test("the in-transaction facts read repos and every open finding", async () => {
  unwrap(
    await seedRows(t.db, {
      repos: [{ id: "r1", name: "r1", mirror_path: "/m/r1" }],
    }),
  );
  unwrap(
    await seedRows(t.db, {
      ticket_repos: [{ ticket_id: "ticket-1", repo_id: "r1" }],
      findings: [
        {
          id: "f1",
          gate_id: "a1",
          severity: "major",
          summary: "x",
          created_at: 0,
        },
        {
          id: "f2",
          gate_id: "a2",
          severity: "nit",
          summary: "y",
          created_at: 0,
          status: "resolved",
        },
      ],
    }),
  );
  const { internalsOf } = await import("../connection.js");
  const ix = unwrap(internalsOf(t.db));
  const ticket = ix.raw
    .prepare("SELECT * FROM tickets WHERE id = 'ticket-1'")
    .get() as Parameters<typeof factsOf>[1];
  const facts = factsOf(ix, ticket);
  expect(facts.repos()).toEqual(["r1"]);
  expect(facts.openFindings()).toEqual([{ gate_id: "a1", severity: "major" }]);
});
