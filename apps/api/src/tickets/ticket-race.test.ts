import { FakeClock, type Actor, type Result } from "@bayon/core";
import { listTicketEvents, openDb } from "@bayon/db";
import { seedSpine, tempDb, unwrap } from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { TicketService } from "./ticket-service.js";

// Contract 3: two writers on two connections move the same version. Both read the ticket and
// gather their facts, a barrier holds them until both have, then both write: exactly one wins,
// the other is a 409 naming the version the winner left.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
const other = unwrap(await openDb({ path: t.path, clock }));
afterAll(async () => {
  unwrap(await other.close());
  t.cleanup();
});

const OPERATOR: Actor = { kind: "operator" };

/** Two services whose `afterFacts` hooks wait for each other. */
function racers() {
  const both = Promise.withResolvers<undefined>();
  let arrived = 0;
  const afterFacts = async () => {
    arrived += 1;
    if (arrived === 2) both.resolve(undefined);
    await both.promise;
  };
  return [
    new TicketService({
      db: t.db,
      clock,
      workRoot: null,
      hooks: { afterFacts },
    }),
    new TicketService({
      db: other,
      clock,
      workRoot: null,
      hooks: { afterFacts },
    }),
  ] as const;
}

const plain = new TicketService({ db: t.db, clock, workRoot: null });

async function ticketAt(): Promise<string> {
  const created = await plain.create(
    { title: "contended", type: "chore" },
    OPERATOR,
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.id;
}

async function expectOneWinner(
  results: readonly Result<unknown>[],
  ticketId: string,
) {
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toMatchObject([
    { ok: false, error: { class: "conflict", cause: { current_version: 2 } } },
  ]);
  const events = unwrap(
    await listTicketEvents(t.db, { ticket_id: ticketId, since: 0, limit: 10 }),
  );
  expect(events.rows.filter((e) => e.kind !== "created")).toHaveLength(1);
}

test("two transitions of one version: exactly one wins", async () => {
  const id = await ticketAt();
  const [a, b] = racers();
  const results = await Promise.all([
    a.transition(id, 1, { to: "prioritized" }, OPERATOR),
    b.transition(id, 1, { to: "parked" }, OPERATOR),
  ]);
  await expectOneWinner(results, id);
});

test("a block and a start: exactly one wins", async () => {
  const id = await ticketAt();
  const [a, b] = racers();
  const results = await Promise.all([
    a.transition(
      id,
      1,
      {
        to: "blocked",
        blocked_reason: "waiting",
        unblock_condition: "done waiting",
      },
      OPERATOR,
    ),
    b.transition(id, 1, { to: "prioritized" }, OPERATOR),
  ]);
  await expectOneWinner(results, id);
});

test("a PATCH and a transition: exactly one wins", async () => {
  const id = await ticketAt();
  const [a, b] = racers();
  const results = await Promise.all([
    a.update(id, 1, { title: "renamed" }, OPERATOR),
    b.transition(id, 1, { to: "prioritized" }, OPERATOR),
  ]);
  await expectOneWinner(results, id);
});
