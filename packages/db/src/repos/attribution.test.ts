import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { SPINE_SEED, seedRows, seedSpine, tempDb, unwrap } from "../testing.js";
import { listAuditByActor, listSessionHumanRequests } from "./attribution.js";
import { insertHumanRequest } from "./coordination.js";

// Who did what (the M1 smoke's reads): a session's audit_log rows and its human requests.
const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 2));
const session = SPINE_SEED.sessionId;
const actor = `session:${session}`;

test("listAuditByActor: one actor's rows in append order, payload as stored", async () => {
  unwrap(
    await seedRows(t.db, {
      audit_log: [
        {
          ts: 3,
          actor,
          action: "mcp.ticket_update",
          target_kind: "session",
          target_id: session,
          payload_json: '{"outcome":"refused:cross_ticket_write"}',
        },
        { ts: 1, actor: "operator", action: "ticket.create" },
        {
          ts: 2,
          actor,
          action: "mcp.ticket_create",
          target_kind: "ticket",
          target_id: "T2",
          payload_json: '{"outcome":"ok"}',
        },
      ],
    }),
  );
  const rows = unwrap(await listAuditByActor(t.db, actor));
  expect(rows.map((r) => [r.action, r.target_id, r.payload_json])).toEqual([
    ["mcp.ticket_update", session, '{"outcome":"refused:cross_ticket_write"}'],
    ["mcp.ticket_create", "T2", '{"outcome":"ok"}'],
  ]);
  expect(unwrap(await listAuditByActor(t.db, "session:nobody"))).toEqual([]);
});

test("listSessionHumanRequests: the session's questions in the order asked, and no one else's", async () => {
  const first = unwrap(
    await insertHumanRequest(t.db, {
      session_id: session,
      kind: "decision",
      question: "a?",
    }),
  );
  await clock.advance(5);
  const second = unwrap(
    await insertHumanRequest(t.db, {
      session_id: session,
      kind: "decision",
      question: "b?",
    }),
  );
  unwrap(
    await insertHumanRequest(t.db, { kind: "decision", question: "orphan?" }),
  );
  const rows = unwrap(await listSessionHumanRequests(t.db, session));
  expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
  expect(rows[0]).toMatchObject({
    status: "open",
    answered_at: null,
    question: "a?",
  });
  expect(unwrap(await listSessionHumanRequests(t.db, "nobody"))).toEqual([]);
});
