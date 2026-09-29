// the Inbox's writers and reads. answerHumanRequest answers once, audited in its own
// transaction; markMessagesRead is idempotent and touches only the recipient's messages.
import { FakeClock } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
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
  getHumanRequest,
  insertHumanRequests,
  listInbox,
  markMessagesRead,
  sendMessage,
} from "./coordination.js";
import {
  answerHumanRequest,
  getInboxRequest,
  inboxAfter,
  listInboxRequests,
} from "./inbox.js";
import { createTicket } from "./ticket-writes.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
afterAll(() => t.cleanup());
const ticket = unwrap(
  await createTicket(t.db, newTicketInput({ title: "Pick a store" }), OPERATOR),
);

const raw = unwrap(internalsOf(t.db)).raw;
const auditRows = () =>
  raw
    .prepare("SELECT actor, action, target_kind, target_id FROM audit_log")
    .all();

const audit = (id: string): AuditEntry => ({
  actor: "operator",
  action: "rest.inbox_answer",
  target_kind: "human_request",
  target_id: id,
});
const answer = (id: string, text = "yes") =>
  answerHumanRequest(
    t.db,
    { id, answer: text, answered_by: "operator" },
    audit(id),
  );

/** One open request, a millisecond after the last: ULIDs of one millisecond have no order. */
async function ask(
  question: string,
  o: { readonly ticket?: boolean; readonly session?: boolean } = {},
) {
  await clock.advance(1);
  const [row] = unwrap(
    await insertHumanRequests(t.db, [
      {
        kind: "decision",
        question,
        options: ["yes", "no"],
        ...(o.session === false ? {} : { session_id: SPINE_SEED.sessionId }),
        ...(o.ticket === true ? { ticket_id: ticket.id } : {}),
      },
    ]),
  );
  if (row === undefined) throw new Error("the batch opened nothing");
  return row;
}

describe("answerHumanRequest", () => {
  test("answers an open request once: status, answer, who and when, audited in the same transaction", async () => {
    const asked = await ask("Ship it?", { ticket: true });
    const audits = auditRows().length;
    await clock.advance(5);
    expect(unwrap(await answer(asked.id, "yes, ship"))).toMatchObject({
      id: asked.id,
      status: "answered",
      answer_json: '"yes, ship"',
      answered_by: "operator",
      answered_at: clock.now(),
    });
    expect(auditRows()).toHaveLength(audits + 1);
    expect(auditRows().at(-1)).toEqual({
      actor: "operator",
      action: "rest.inbox_answer",
      target_kind: "human_request",
      target_id: asked.id,
    });
  });

  test("a second answer is conflict and changes nothing; an unknown request is not_found; neither is audited", async () => {
    const asked = await ask("Which store?");
    const first = unwrap(await answer(asked.id, "sqlite"));
    const audits = auditRows().length;
    await clock.advance(5);
    expect(await answer(asked.id, "postgres")).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
    expect(await answer("no-such-request")).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    expect(unwrap(await getHumanRequest(t.db, asked.id))).toEqual(first);
    expect(auditRows()).toHaveLength(audits);
  });

  test("an empty answer or answerer is refused before any write", async () => {
    const asked = await ask("Retry?");
    const audits = auditRows().length;
    for (const bad of [
      { answer: " \n", answered_by: "operator" },
      { answer: "yes", answered_by: "" },
    ]) {
      expect(
        await answerHumanRequest(
          t.db,
          { id: asked.id, ...bad },
          audit(asked.id),
        ),
        JSON.stringify(bad),
      ).toMatchObject({ ok: false, error: { class: "validation" } });
    }
    expect(unwrap(await getHumanRequest(t.db, asked.id)).status).toBe("open");
    expect(auditRows()).toHaveLength(audits);
  });

  test("an audit entry that cannot be written rolls the answer back", async () => {
    const asked = await ask("Rollback?");
    const audits = auditRows().length;
    expect(
      await answerHumanRequest(
        t.db,
        { id: asked.id, answer: "yes", answered_by: "operator" },
        { actor: "", action: "rest.inbox_answer" },
      ),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(unwrap(await getHumanRequest(t.db, asked.id))).toMatchObject({
      status: "open",
      answer_json: null,
      answered_at: null,
    });
    expect(auditRows()).toHaveLength(audits);
  });
});

describe("listInboxRequests and getInboxRequest", () => {
  test("open first, newest asked first, each with its ticket and session", async () => {
    const older = await ask("older", { ticket: true });
    const answered = await ask("answered");
    const orphan = await ask("no session, no ticket", { session: false });
    unwrap(await answer(answered.id));
    const mine = new Set([older.id, answered.id, orphan.id]);

    const page = unwrap(await listInboxRequests(t.db, { limit: 1000 }));
    expect(page.hasMore).toBe(false);
    const statuses = page.rows.map((r) => r.status);
    expect(statuses.indexOf("answered")).toBeGreaterThan(
      statuses.lastIndexOf("open"),
    );
    expect(page.rows.filter((r) => mine.has(r.id)).map((r) => r.id)).toEqual([
      orphan.id,
      older.id,
      answered.id,
    ]);

    expect(unwrap(await getInboxRequest(t.db, older.id))).toMatchObject({
      question: "older",
      ticket_num: ticket.num,
      ticket_title: "Pick a store",
      ticket_status: "backlog",
      session_role: "builder",
      session_state: "idle",
      agent_name: SPINE_SEED.agentName,
    });
    expect(unwrap(await getInboxRequest(t.db, orphan.id))).toMatchObject({
      ticket_num: null,
      ticket_title: null,
      session_role: null,
      agent_name: null,
    });
    expect(await getInboxRequest(t.db, "no-such-request")).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  });

  test("a status keeps one kind; pages resume after a row; a bad query is refused", async () => {
    const all = unwrap(await listInboxRequests(t.db, { limit: 1000 })).rows;
    const answeredOnly = unwrap(
      await listInboxRequests(t.db, { status: "answered", limit: 1000 }),
    ).rows;
    expect(answeredOnly.length).toBeGreaterThan(0);
    expect(answeredOnly.every((r) => r.status === "answered")).toBe(true);
    expect(answeredOnly.map((r) => r.id)).toEqual(
      all.filter((r) => r.status === "answered").map((r) => r.id),
    );

    const [top, next] = all;
    if (top === undefined || next === undefined) throw new Error("too few");
    const second = unwrap(
      await listInboxRequests(t.db, { after: inboxAfter(top), limit: 1 }),
    );
    expect(second.rows.map((r) => r.id)).toEqual([next.id]);
    expect(second.hasMore).toBe(true);
    const last = all.at(-1);
    if (last === undefined) throw new Error("no rows");
    const past = unwrap(
      await listInboxRequests(t.db, { after: inboxAfter(last), limit: 5 }),
    );
    expect(past).toEqual({ rows: [], hasMore: false });
    for (const bad of [
      { limit: 0 },
      { limit: 1, after: { rank: 2, asked_at: 1, id: "x" } },
    ]) {
      expect(
        await listInboxRequests(t.db, bad as never),
        JSON.stringify(bad),
      ).toMatchObject({ ok: false, error: { class: "validation" } });
    }
  });

  test("answering a request between two page fetches skips no open request", async () => {
    const first = await ask("first");
    const second = await ask("second");
    const third = await ask("third");
    for (const status of ["open", undefined]) {
      const scope = status === undefined ? {} : { status };
      const page1 = unwrap(
        await listInboxRequests(t.db, { ...scope, limit: 1 }),
      );
      const top = page1.rows[0];
      if (top === undefined) throw new Error("no open request");
      unwrap(await answer(top.id));
      const page2 = unwrap(
        await listInboxRequests(t.db, {
          ...scope,
          after: inboxAfter(top),
          limit: 1,
        }),
      );
      // An offset of 1 would land one row further down: the next open request, skipped.
      expect(page2.rows.map((r) => r.id)).toEqual([
        top.id === third.id ? second.id : first.id,
      ]);
    }
  });
});

describe("markMessagesRead", () => {
  const note = (to_id: string) =>
    sendMessage(t.db, {
      from_kind: "session",
      from_id: SPINE_SEED.sessionId,
      to_kind: "agent",
      to_id,
      kind: "note",
      subject: "hi",
      body_md: "body",
    });
  const inboxOf = async (to_id: string) =>
    unwrap(await listInbox(t.db, { to_kind: "agent", to_id, limit: 10 }));

  test("stamps the recipient's unread messages once, and never another recipient's", async () => {
    const a1 = unwrap(await note("reader-a"));
    await clock.advance(1);
    const a2 = unwrap(await note("reader-a"));
    const b1 = unwrap(await note("reader-b"));
    const mark = (ids: string[]) =>
      markMessagesRead(t.db, { to_kind: "agent", to_id: "reader-a", ids });

    await clock.advance(10);
    const readAt = clock.now();
    expect(unwrap(await mark([a1.id, b1.id]))).toBe(1);
    await clock.advance(10);
    expect(unwrap(await mark([a1.id, b1.id]))).toBe(0);

    expect((await inboxOf("reader-a")).map((m) => [m.id, m.read_at])).toEqual([
      [a1.id, readAt],
      [a2.id, null],
    ]);
    expect((await inboxOf("reader-b")).map((m) => m.read_at)).toEqual([null]);
  });

  test("no ids is a no-op; an empty recipient is refused", async () => {
    expect(
      unwrap(
        await markMessagesRead(t.db, {
          to_kind: "agent",
          to_id: "reader-a",
          ids: [],
        }),
      ),
    ).toBe(0);
    expect(
      await markMessagesRead(t.db, { to_kind: "agent", to_id: "", ids: ["x"] }),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  });
});
