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
import { blockTicket } from "./block-ticket.js";
import { createTicket } from "./ticket-writes.js";

// blockTicket: the block edge through core's laws as the supervisor, with the
// patch core's plan builds, its request, transition event and audit row in one transaction; held
// and closed tickets refused before anything is written.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 14));
afterAll(() => t.cleanup());

const raw = unwrap(internalsOf(t.db)).raw;
const requests = () =>
  (
    raw.prepare("SELECT COUNT(*) AS n FROM human_requests").get() as {
      n: number;
    }
  ).n;

const make = async (status: string) =>
  unwrap(await createTicket(t.db, newTicketInput({ status }), OPERATOR));

const request = (ticketId: string, window: string): SystemHumanRequest => ({
  rule: "circuit",
  subject: ticketId,
  window,
  question:
    "It failed 3 times in a row and is blocked. Retry it, re-plan it, or park it?",
  context_md: "- run r1 failed (runner_exited_without_terminal)",
  options: ["unblock and retry", "re-plan", "park", "reject"],
});

const block = (ticketId: string, window = "1") =>
  blockTicket(t.db, {
    ticketId,
    blockedReason: "circuit breaker: 3 failed runs",
    unblockCondition:
      "answer the request, then unblock (operator or orchestrator)",
    request: request(ticketId, window),
  });

test("blocks an open ticket through the law, with its request, event and audit together", async () => {
  const ticket = await make("building");
  const out = unwrap(await block(ticket.id));
  expect(out.blocked).toBe(true);
  if (!out.blocked) return;
  expect(out.ticket).toMatchObject({
    status: "blocked",
    version: ticket.version + 1,
    blocked_reason: "circuit breaker: 3 failed runs",
  });
  expect(out.ticket.unblock_condition).toBe(
    `answer the request, then unblock (operator or orchestrator) (human request ${out.request.id})`,
  );
  expect(out.request).toMatchObject({
    kind: "circuit_breaker",
    ticket_id: ticket.id,
    dedupe_key: `circuit:${ticket.id}:1`,
  });
  expect(
    raw
      .prepare(
        "SELECT actor_kind, actor_id, from_status, to_status FROM ticket_events WHERE ticket_id = ? AND kind = 'transition'",
      )
      .all(ticket.id),
  ).toEqual([
    {
      actor_kind: "supervisor",
      actor_id: "watchdog",
      from_status: "building",
      to_status: "blocked",
    },
  ]);
  expect(
    raw
      .prepare(
        "SELECT actor, action FROM audit_log WHERE target_id = ? AND action = 'supervisor.block_ticket'",
      )
      .all(ticket.id),
  ).toEqual([{ actor: "supervisor", action: "supervisor.block_ticket" }]);
});

test("already blocked, held and closed tickets are not blocked, and nothing is written", async () => {
  const cases = [
    ["blocked", "already_blocked"],
    ["parked", "held"],
    ["split", "held"],
    ["done", "closed"],
    ["rejected", "closed"],
  ] as const;
  for (const [status, reason] of cases) {
    const ticket = await make(status);
    const before = requests();
    const out = unwrap(await block(ticket.id));
    expect(out, status).toEqual({ blocked: false, reason, status });
    expect(requests(), status).toBe(before);
  }
});

test("a failure after the request is filed rolls the request back", async () => {
  const ticket = await make("building");
  raw.exec(`CREATE TRIGGER refuse_block BEFORE UPDATE OF status ON tickets
            WHEN NEW.status = 'blocked' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  try {
    const before = requests();
    const out = await block(ticket.id);
    expect(out.ok).toBe(false);
    expect(requests()).toBe(before);
  } finally {
    raw.exec("DROP TRIGGER refuse_block");
  }
});

test("two calls for one incident give one block and one request", async () => {
  const ticket = await make("review_fix");
  const before = requests();
  const [a, b] = await Promise.all([
    block(ticket.id, "7"),
    block(ticket.id, "7"),
  ]);
  const outcomes = [unwrap(a), unwrap(b)].map((o) =>
    o.blocked ? "blocked" : o.reason,
  );
  expect(outcomes.toSorted()).toEqual(["already_blocked", "blocked"]);
  expect(requests()).toBe(before + 1);
});

test("an unknown ticket is not_found", async () => {
  const out = await block("no-such-ticket");
  expect(!out.ok && out.error.class).toBe("not_found");
});
