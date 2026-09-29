import { FakeClock, ok } from "@bayon/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  OPERATOR,
  SPINE_SEED,
  listCommands,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "../testing.js";
import { staffTicket } from "./staffing.js";
import { listTicketEvents } from "./ticket-events.js";
import type { TicketActor } from "./ticket-common.js";
import type { Decide } from "./ticket-transition.js";
import { getTicket } from "./tickets.js";

// The staffing writer holds a project's orchestrator to its project, whatever door
// called it: a session caller whose agent has a project is refused `cross_project` on a ticket in
// another project or in none, and writes nothing. The operator, and an orchestrator with no project,
// staff as before. A real temp SQLite file; each project has a free builder of its own.

const NOW = Date.UTC(2026, 8, 21, 12);
const allow: Decide = () => ok(undefined);

let t: TempDb;

const agent = (
  id: string,
  kind: "builder" | "orchestrator",
  workspace_id: string | null,
) => ({
  id,
  name: id,
  kind,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  workspace_id,
  created_at: 1,
});
const orchestratorSession = (id: string, agent_id: string) => ({
  ...newSessionInput(),
  id,
  agent_id,
  role: "orchestrator",
  state: "running" as const,
  created_at: 0,
});
/** The actor TicketService records for an orchestrator's session (actorRef). */
const asSession = (id: string): TicketActor => ({
  actor_kind: "session",
  actor_id: id,
});

beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(NOW)));
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
      agents: [
        agent("O-A", "orchestrator", "P-A"),
        agent("O-F", "orchestrator", null),
        agent("A-1", "builder", "P-A"),
        agent("B-1", "builder", "P-B"),
        agent("U-1", "builder", null),
      ],
      tickets: [
        ticketRow(1, { status: "prioritized", workspace_id: "P-A" }),
        ticketRow(2, { status: "prioritized", workspace_id: "P-B" }),
        ticketRow(3, { status: "prioritized" }),
      ],
      sessions: [
        orchestratorSession("S-OA", "O-A"),
        orchestratorSession("S-OF", "O-F"),
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const staff = (num: number, by: TicketActor, idempotencyKey?: string) =>
  staffTicket(
    t.db,
    {
      ticket_id: `ticket-${num}`,
      role: "builder",
      by,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
    allow,
  );

const spawns = async () =>
  unwrap(await listCommands(t.db)).filter((c) => c.type === "session.spawn");

const eventsOf = async (num: number) =>
  unwrap(
    await listTicketEvents(t.db, {
      ticket_id: `ticket-${num}`,
      since: 0,
      limit: 50,
    }),
  ).rows;

test("A's orchestrator staffing B's ticket, or one with no project, is cross_project and writes nothing", async () => {
  expect(unwrap(await staff(2, asSession("S-OA")))).toEqual({
    kind: "refused",
    reason: "cross_project",
    detail: "ticket #2 is not in project P-A, the only one this caller works",
  });
  expect(unwrap(await staff(3, asSession("S-OA"), "key-3"))).toEqual({
    kind: "refused",
    reason: "cross_project",
    detail: "ticket #3 has no project; this caller works only project P-A",
  });
  expect(await spawns()).toEqual([]);
  for (const num of [2, 3]) {
    expect(unwrap(await getTicket(t.db, `ticket-${num}`))).toMatchObject({
      status: "prioritized",
      version: 1,
    });
    expect(await eventsOf(num)).toEqual([]);
  }
  // Its own project's ticket it staffs, onto its own project's builder.
  expect(unwrap(await staff(1, asSession("S-OA")))).toMatchObject({
    kind: "staffed",
    payload: { agent_id: "A-1", workspace_id: "P-A" },
  });
});

test("the refusal comes before an idempotent replay: a key another door used is still refused", async () => {
  expect(unwrap(await staff(2, OPERATOR, "shared-key"))).toMatchObject({
    kind: "staffed",
  });
  expect(unwrap(await staff(2, asSession("S-OA"), "shared-key"))).toMatchObject(
    { kind: "refused", reason: "cross_project" },
  );
});

test("the operator and a fleet orchestrator staff any project's ticket, and one with none", async () => {
  expect(unwrap(await staff(2, OPERATOR))).toMatchObject({
    kind: "staffed",
    payload: { agent_id: "B-1", workspace_id: "P-B" },
  });
  expect(unwrap(await staff(1, asSession("S-OF")))).toMatchObject({
    kind: "staffed",
    payload: { agent_id: "A-1" },
  });
  expect(unwrap(await staff(3, asSession("S-OF")))).toMatchObject({
    kind: "staffed",
  });
  expect(await spawns()).toHaveLength(3);
});

test("an unknown ticket is still not_found for a project's orchestrator, not cross_project", async () => {
  const r = await staffTicket(
    t.db,
    { ticket_id: "ticket-99", role: "builder", by: asSession("S-OA") },
    allow,
  );
  expect(!r.ok && r.error.class).toBe("not_found");
});
