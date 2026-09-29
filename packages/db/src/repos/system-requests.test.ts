import { FakeClock, type SystemHumanRequest } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import {
  OPERATOR,
  newTicketInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { insertHumanRequest } from "./coordination.js";
import { insertSystemHumanRequest } from "./system-requests.js";
import { createTicket } from "./ticket-writes.js";

// insertSystemHumanRequest: one row per key, the database refusing a second;
// a created row audited with actor 'supervisor', and a ticket_events row when it names a ticket.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 14));
afterAll(() => t.cleanup());

const raw = unwrap(internalsOf(t.db)).raw;
const count = (sql: string, ...params: unknown[]): number =>
  (raw.prepare(sql).get(...params) as { n: number }).n;
const audits = () =>
  count("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'supervisor'");
const requestEvents = (ticketId: string) =>
  count(
    "SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ? AND kind = 'human_request' AND actor_kind = 'supervisor'",
    ticketId,
  );

const ticket = unwrap(
  await createTicket(t.db, newTicketInput({ status: "building" }), OPERATOR),
);
const request = (o: Partial<SystemHumanRequest> = {}): SystemHumanRequest => ({
  rule: "split",
  subject: ticket.id,
  window: "4",
  question: "split it?",
  context_md: "4 hand-offs, 1 degraded",
  options: ["keep going", "split by hand"],
  ticket_id: ticket.id,
  ...o,
});

test("a system request is filed once, with its audit row and ticket event", async () => {
  const before = { audits: audits(), events: requestEvents(ticket.id) };
  const filed = unwrap(await insertSystemHumanRequest(t.db, request()));
  expect(filed.created).toBe(true);
  expect(filed.row).toMatchObject({
    kind: "split",
    status: "open",
    ticket_id: ticket.id,
    dedupe_key: `split:${ticket.id}:4`,
    options_json: JSON.stringify(["keep going", "split by hand"]),
  });
  expect(audits()).toBe(before.audits + 1);
  expect(requestEvents(ticket.id)).toBe(before.events + 1);

  const again = unwrap(
    await insertSystemHumanRequest(t.db, request({ question: "a new text" })),
  );
  expect(again.created).toBe(false);
  expect(again.row.id).toBe(filed.row.id);
  expect(again.row.question).toBe("split it?");
  expect(audits()).toBe(before.audits + 1);
  expect(requestEvents(ticket.id)).toBe(before.events + 1);
});

test("another window files another request; one with no ticket writes no ticket event", async () => {
  const next = unwrap(
    await insertSystemHumanRequest(t.db, request({ window: "5" })),
  );
  expect(next.created).toBe(true);
  const events = requestEvents(ticket.id);
  const storm = unwrap(
    await insertSystemHumanRequest(t.db, {
      rule: "retry_storm",
      subject: "fixture/local",
      window: "0",
      question: "retry storm",
      context_md: "",
      options: ["ack"],
      expires_at: clock.now() + 1,
    }),
  );
  expect(storm.created).toBe(true);
  expect(storm.row).toMatchObject({
    kind: "retry_storm",
    ticket_id: null,
    expires_at: clock.now() + 1,
  });
  expect(requestEvents(ticket.id)).toBe(events);
});

test("human_ask's rows keep a NULL key and never conflict", async () => {
  const asked = [1, 2].map(() => ({
    kind: "question",
    question: "same text",
    ticket_id: ticket.id,
  }));
  for (const h of asked) {
    expect(unwrap(await insertHumanRequest(t.db, h)).dedupe_key).toBeNull();
  }
});

test("a key part with a colon is refused, and nothing is written", async () => {
  const rows = count("SELECT COUNT(*) AS n FROM human_requests");
  const refused = await insertSystemHumanRequest(
    t.db,
    request({ subject: "a:b" }),
  );
  expect(!refused.ok && refused.error.class).toBe("validation");
  expect(count("SELECT COUNT(*) AS n FROM human_requests")).toBe(rows);
});
