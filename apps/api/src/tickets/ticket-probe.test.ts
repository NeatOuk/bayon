import { FakeClock, type Actor } from "@bayon/core";
import { getTicket, listTickets } from "@bayon/db";
import { seedSpine, tempDb, unwrap } from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { TicketService } from "./ticket-service.js";

// A probe finding's ticket (§10.2): origin probe, needs_human, and one ticket per
// fingerprint, even when two calls race.
const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 4));
afterAll(() => t.cleanup());

const service = new TicketService({ db: t.db, clock, workRoot: null });
const ORCH: Actor = { kind: "orchestrator", sessionId: "orch-1" };
const body = { title: "budget: over the daily cap", type: "chore" as const };

const count = async () =>
  unwrap(await listTickets(t.db, { limit: 1000 })).rows.length;

test("files an origin-probe ticket that waits for a human, and a repeat returns it unchanged", async () => {
  const before = await count();
  const first = unwrap(await service.createFromProbe(body, "fp-a", ORCH));
  expect(first.created).toBe(true);
  expect(first.ticket).toMatchObject({ status: "backlog", needs_human: true });
  expect(unwrap(await getTicket(t.db, first.ticket.id))).toMatchObject({
    origin: "probe",
    origin_ref: "orch-1",
    origin_fingerprint: "fp-a",
  });
  const again = unwrap(
    await service.createFromProbe({ ...body, title: "other" }, "fp-a", ORCH),
  );
  expect(again).toEqual({ ticket: first.ticket, created: false });
  expect(await count()).toBe(before + 1);
});

test("two concurrent calls with one fingerprint file one ticket and both get it", async () => {
  const before = await count();
  const [a, b] = await Promise.all([
    service.createFromProbe(body, "fp-race", ORCH),
    service.createFromProbe(body, "fp-race", ORCH),
  ]);
  const both = [unwrap(a), unwrap(b)];
  expect(both.map((r) => r.created).toSorted()).toEqual([false, true]);
  expect(both[0]?.ticket.id).toBe(both[1]?.ticket.id);
  expect(await count()).toBe(before + 1);
});

test("without a fingerprint nothing dedupes; an empty fingerprint is refused", async () => {
  const a = unwrap(await service.create(body, ORCH));
  const b = unwrap(await service.create(body, ORCH));
  expect(a.id).not.toBe(b.id);
  expect(unwrap(await getTicket(t.db, a.id))).toMatchObject({
    origin: "agent",
    origin_fingerprint: null,
  });
  expect(await service.createFromProbe(body, "", ORCH)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("only the orchestrator files a finding: a worker or the operator cannot squat a fingerprint", async () => {
  const before = await count();
  for (const actor of [
    { kind: "worker", sessionId: "s-1" },
    { kind: "operator" },
  ] as const) {
    expect(
      await service.createFromProbe(body, "fp-squat", actor),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  }
  expect(await count()).toBe(before);
  expect(
    unwrap(await service.createFromProbe(body, "fp-squat", ORCH)).created,
  ).toBe(true);
});
