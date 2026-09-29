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
import {
  getHumanRequest,
  insertHumanRequest,
  listInbox,
  sendMessage,
  type NewMessage,
} from "./coordination.js";
import { appendKnowledge, searchKnowledge } from "./knowledge.js";
import { createTicket } from "./ticket-writes.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
afterAll(() => t.cleanup());
const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));

const validation = { ok: false, error: { class: "validation" } };
const message = (o: Partial<NewMessage> = {}): NewMessage => ({
  from_kind: "agent",
  from_id: "orchestrator",
  to_kind: "agent",
  to_id: "builder-1",
  kind: "note",
  subject: "hello",
  body_md: "body",
  ...o,
});

test("sendMessage stores a message stamped now; listInbox returns one recipient's, oldest first", async () => {
  const first = unwrap(
    await sendMessage(
      t.db,
      message({ subject: "first", ticket_id: ticket.id, requires_ack: true }),
    ),
  );
  await clock.advance(10);
  const second = unwrap(
    await sendMessage(t.db, message({ subject: "second" })),
  );
  unwrap(await sendMessage(t.db, message({ to_id: "someone-else" })));
  unwrap(await sendMessage(t.db, message({ to_kind: "operator" })));
  expect(first).toMatchObject({
    ts: second.ts - 10,
    ticket_id: ticket.id,
    requires_ack: 1,
    correlation_id: null,
    delivered_at: null,
    read_at: null,
    acked_at: null,
  });
  expect(second).toMatchObject({ ticket_id: null, requires_ack: 0 });
  expect(
    unwrap(
      await listInbox(t.db, {
        to_kind: "agent",
        to_id: "builder-1",
        limit: 10,
      }),
    ),
  ).toEqual([first, second]);
});

test("listInbox with unread_only leaves read messages out", async () => {
  const unread = unwrap(await sendMessage(t.db, message({ to_id: "reader" })));
  await clock.advance(1); // ULIDs minted in one millisecond have no defined order
  const read = unwrap(await sendMessage(t.db, message({ to_id: "reader" })));
  unwrap(internalsOf(t.db))
    .raw.prepare("UPDATE messages SET read_at = 1 WHERE id = ?")
    .run(read.id);
  const inbox = (unread_only: boolean) =>
    listInbox(t.db, {
      to_kind: "agent",
      to_id: "reader",
      unread_only,
      limit: 10,
    });
  expect(unwrap(await inbox(true))).toEqual([unread]);
  expect(unwrap(await inbox(false)).map((m) => m.id)).toEqual([
    unread.id,
    read.id,
  ]);
});

test("listInbox refuses a bad limit; sendMessage refuses an empty recipient, subject or kind", async () => {
  expect(
    await listInbox(t.db, { to_kind: "agent", to_id: "x", limit: 0 }),
  ).toMatchObject(validation);
  for (const bad of [{ to_id: "" }, { subject: "" }, { kind: "" }]) {
    expect(
      await sendMessage(t.db, message(bad)),
      JSON.stringify(bad),
    ).toMatchObject(validation);
  }
});

test("insertHumanRequest opens the request at once; getHumanRequest reads it back", async () => {
  const request = unwrap(
    await insertHumanRequest(t.db, {
      session_id: SPINE_SEED.sessionId,
      ticket_id: ticket.id,
      kind: "decision",
      question: "Ship it?",
      options: ["yes", "no"],
    }),
  );
  expect(request).toMatchObject({
    status: "open",
    asked_at: clock.now(),
    options_json: '["yes","no"]',
    context_md: null,
    answer_json: null,
    answered_by: null,
    answered_at: null,
    expires_at: null,
  });
  expect(unwrap(await getHumanRequest(t.db, request.id))).toEqual(request);
  expect(await getHumanRequest(t.db, "nope")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("insertHumanRequest refuses an empty question or kind, and options that are not JSON", async () => {
  for (const bad of [
    { kind: "decision", question: "" },
    { kind: "", question: "?" },
    { kind: "decision", question: "?", options: { n: 1n } },
  ]) {
    expect(await insertHumanRequest(t.db, bad)).toMatchObject(validation);
  }
});

test("appendKnowledge proposes an entry; searchKnowledge finds it by title or body", async () => {
  const wal = unwrap(
    await appendKnowledge(t.db, {
      scope: "repo",
      scope_ref: "bayon",
      kind: "trap",
      title: "WAL needs a local disk",
      body_md: "Never put foreman.db on NFS: WAL needs shared memory.",
      source_ticket_id: ticket.id,
    }),
  );
  const busy = unwrap(
    await appendKnowledge(t.db, {
      scope: "global",
      kind: "rule",
      title: "Do not raise busy_timeout",
      body_md: "Batch the writes instead; WAL contention is a batching bug.",
    }),
  );
  expect(wal).toMatchObject({
    status: "proposed",
    hits: 0,
    created_at: clock.now(),
    reviewed_at: null,
    promoted_path: null,
    source_ticket_id: ticket.id,
  });
  const ids = async (q: string, limit = 10) =>
    unwrap(await searchKnowledge(t.db, { q, limit })).map((k) => k.id);
  expect(await ids("nfs")).toEqual([wal.id]);
  expect(await ids("local disk")).toEqual([wal.id]);
  expect(await ids("batching")).toEqual([busy.id]);
  expect((await ids("wal")).toSorted()).toEqual([wal.id, busy.id].toSorted());
  expect(await ids("wal", 1)).toHaveLength(1);
  expect(await ids("absent")).toEqual([]);
});

test("searchKnowledge refuses an empty query or bad limit; appendKnowledge an empty field", async () => {
  expect(await searchKnowledge(t.db, { q: " ", limit: 10 })).toMatchObject(
    validation,
  );
  expect(await searchKnowledge(t.db, { q: "x", limit: 0 })).toMatchObject(
    validation,
  );
  const entry = { scope: "repo", kind: "trap", title: "t", body_md: "b" };
  for (const bad of [
    { title: "" },
    { body_md: "" },
    { scope: "" },
    { kind: "" },
  ]) {
    expect(
      await appendKnowledge(t.db, { ...entry, ...bad }),
      JSON.stringify(bad),
    ).toMatchObject(validation);
  }
});
