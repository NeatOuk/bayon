// Design an earlier change §6: an MCP write and its audit_log row commit in one transaction (an `audit`
// argument on the API's writers), and human_ask's batch opens in one transaction too.
import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import {
  OPERATOR,
  SPINE_SEED,
  newTicketInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import type { AuditEntry } from "./audit.js";
import {
  insertHumanRequests,
  listTicketHumanRequests,
  sendMessage,
} from "./coordination.js";
import { appendKnowledge } from "./knowledge.js";
import { createTicket } from "./ticket-writes.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
afterAll(() => t.cleanup());

const raw = unwrap(internalsOf(t.db)).raw;
const count = (table: "audit_log" | "messages" | "human_requests") =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const lastAudit = () =>
  raw
    .prepare("SELECT action, actor, target_id FROM audit_log ORDER BY id DESC")
    .get();

const SESSION = SPINE_SEED.sessionId;
const audit = (action: string): AuditEntry => ({
  actor: `session:${SESSION}`,
  action,
  target_kind: "session",
  target_id: SESSION,
  payload: { outcome: "ok" },
});
const message = {
  from_kind: "session",
  from_id: SESSION,
  to_kind: "agent",
  to_id: SPINE_SEED.agentName,
  kind: "note",
  subject: "hi",
  body_md: "body",
};

test("sendMessage with an audit entry commits the message and its audit row together", async () => {
  const audits = count("audit_log");
  const sent = unwrap(
    await sendMessage(t.db, message, audit("mcp.mailbox_send")),
  );
  expect(sent.subject).toBe("hi");
  expect(count("audit_log")).toBe(audits + 1);
  expect(lastAudit()).toEqual({
    action: "mcp.mailbox_send",
    actor: `session:${SESSION}`,
    target_id: SESSION,
  });
});

test("an audit entry that cannot be written rolls the write back", async () => {
  const messages = count("messages");
  const audits = count("audit_log");
  expect(
    await sendMessage(t.db, message, { actor: "", action: "mcp.mailbox_send" }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(count("messages")).toBe(messages);
  expect(count("audit_log")).toBe(audits);
});

test("insertHumanRequests opens a batch in one transaction: one batch id, one audit row", async () => {
  const audits = count("audit_log");
  const rows = unwrap(
    await insertHumanRequests(
      t.db,
      [
        {
          session_id: SESSION,
          kind: "decision",
          question: "Ship it?",
          options: ["yes", "no"],
        },
        {
          session_id: SESSION,
          kind: "decision",
          question: "Which store?",
          options: ["sqlite", "pg"],
        },
      ],
      audit("mcp.human_ask"),
    ),
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]?.batch_id).toEqual(expect.any(String));
  expect(new Set(rows.map((r) => r.batch_id)).size).toBe(1);
  expect(
    rows.every((r) => r.status === "open" && r.session_id === SESSION),
  ).toBe(true);
  expect(rows.map((r) => r.options_json)).toEqual([
    '["yes","no"]',
    '["sqlite","pg"]',
  ]);
  expect(count("audit_log")).toBe(audits + 1);
});

test("insertHumanRequests refuses an empty batch or a blank question and writes nothing", async () => {
  const requests = count("human_requests");
  expect(await insertHumanRequests(t.db, [])).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(
    await insertHumanRequests(t.db, [
      { kind: "decision", question: "fine" },
      { kind: "decision", question: " " },
    ]),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(count("human_requests")).toBe(requests);
});

test("appendKnowledge with an audit entry is audited in the same transaction", async () => {
  const audits = count("audit_log");
  unwrap(
    await appendKnowledge(
      t.db,
      {
        scope: "global",
        kind: "trap",
        title: "WAL needs a local disk",
        body_md: "Never NFS.",
        source_session_id: SESSION,
      },
      audit("mcp.memory_append"),
    ),
  );
  expect(count("audit_log")).toBe(audits + 1);
  expect(lastAudit()).toMatchObject({ action: "mcp.memory_append" });
});

test("listTicketHumanRequests: a ticket's requests, newest first, up to the limit", async () => {
  const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  const ask = (question: string) => ({
    session_id: SESSION,
    ticket_id: ticket.id,
    kind: "decision",
    question,
  });
  unwrap(await insertHumanRequests(t.db, [ask("first")]));
  await clock.advance(1);
  unwrap(await insertHumanRequests(t.db, [ask("second")]));
  await clock.advance(1);
  unwrap(await insertHumanRequests(t.db, [ask("third")]));
  const newest = unwrap(await listTicketHumanRequests(t.db, ticket.id, 2));
  expect(newest.map((r) => r.question)).toEqual(["third", "second"]);
  expect(
    unwrap(await listTicketHumanRequests(t.db, "no-such-ticket", 5)),
  ).toEqual([]);
});
