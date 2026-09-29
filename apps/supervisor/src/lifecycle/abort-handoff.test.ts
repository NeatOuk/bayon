// §13.1 for a spawn that never started: a session holding a ticket leaves a degraded
// hand-off even when it aborts, so the ticket is re-staffable instead of stranded with no live
// owner, no pending hand-off and no terminal status. Both runtime paths end through `abort` —
// spawn.ts's unwind and admission's refuseOne — so end.ts's HOOKED set is the one choke point.
import { FakeClock } from "@bayon/core";
import { listHandoffs, type Db } from "@bayon/db";
import {
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
} from "@bayon/db/testing";
import { afterAll, expect, test, vi } from "vitest";
import {
  admissionRows,
  startAdmission,
  T0,
  WAIT,
  type WorldOptions,
} from "./testing/admission-world.js";
import { AGENT_ID, EXECUTOR_ID } from "./testing/fixtures.js";

const TICKET = "ticket-1";
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function world(o: WorldOptions = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(
    await seedRows(t.db, {
      ...admissionRows(o),
      tickets: [ticketRow(1, { status: "staffed" })],
    }),
  );
  const w = await startAdmission(t.db, clock, o);
  cleanups.push(async () => {
    await w.shutdown();
    t.cleanup();
  });
  return w;
}

/** The ticket's hand-off rows, so a test can say there is exactly one and what it says. */
async function handoffsOf(db: Db) {
  return unwrap(await listHandoffs(db, { ticketId: TICKET, limit: 10 })).rows;
}

test("a queued holder refused late leaves a degraded hand-off, not a stranded ticket", async () => {
  // Queued on `unhealthy`, then refused by `disabled` — a refuse gate whose fact changed while it
  // waited, which is admission's refuseOne path and second case.
  const w = await world({ rows: { healthArgv: ["fail"] } });
  unwrap(await w.spawn("S1", { ticket_id: TICKET, role: "builder" }));
  await w.until("S1", { state: "pending", queued_reason: "unhealthy" });
  expect(await handoffsOf(w.db)).toHaveLength(0);

  unwrap(
    await updateRowForTest(w.db, "executors", EXECUTOR_ID, { enabled: 0 }),
  );
  await w.recheck();
  await vi.waitFor(async () => {
    expect((await w.session("S1")).state).toBe("exited");
  }, WAIT);

  const rows = await handoffsOf(w.db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    ticket_id: TICKET,
    from_session_id: "S1",
    quality: "degraded",
    reason: "session_death",
  });
  // Pending, so the ticket has exactly one of the three §13.1 outcomes: a hand-off to take.
  expect(rows[0]?.accepted_at).toBeNull();
});

test("a session that holds nothing still aborts without a hand-off", async () => {
  const w = await world({ rows: { healthArgv: ["fail"] } });
  unwrap(await w.spawn("S2", { role: "util" }));
  await w.until("S2", { state: "pending", queued_reason: "unhealthy" });

  unwrap(
    await updateRowForTest(w.db, "executors", EXECUTOR_ID, { enabled: 0 }),
  );
  await w.recheck();
  await vi.waitFor(async () => {
    expect((await w.session("S2")).state).toBe("exited");
  }, WAIT);
  expect(await handoffsOf(w.db)).toHaveLength(0);
});

test("the abort's packet says the spawn never finished, with the gate that refused it", async () => {
  const w = await world({ rows: { healthArgv: ["fail"] } });
  unwrap(await w.spawn("S3", { ticket_id: TICKET, role: "builder" }));
  await w.until("S3", { state: "pending", queued_reason: "unhealthy" });
  unwrap(
    await updateRowForTest(w.db, "executors", EXECUTOR_ID, { enabled: 0 }),
  );
  await w.recheck();
  await vi.waitFor(async () => {
    expect((await w.session("S3")).state).toBe("exited");
  }, WAIT);

  const rows = await handoffsOf(w.db);
  const facts = JSON.parse(String(rows[0]?.facts_json)) as { why?: string };
  expect(facts.why).toContain("its spawn did not finish");
  expect(facts.why).toContain("admission_refused");
});

test("the agent is the one the spawn named, so the ticket's next session inherits its context", async () => {
  const w = await world({ rows: { healthArgv: ["fail"] } });
  unwrap(await w.spawn("S4", { ticket_id: TICKET, role: "builder" }));
  await w.until("S4", { state: "pending", queued_reason: "unhealthy" });
  unwrap(
    await updateRowForTest(w.db, "executors", EXECUTOR_ID, { enabled: 0 }),
  );
  await w.recheck();
  await vi.waitFor(async () => {
    expect((await w.session("S4")).state).toBe("exited");
  }, WAIT);
  expect((await w.session("S4")).agent_id).toBe(AGENT_ID);
  expect(await handoffsOf(w.db)).toHaveLength(1);
});
