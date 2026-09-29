import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { OPERATOR, newTicketInput, tempDb, unwrap } from "../testing.js";
import {
  appendTicketEvent,
  linkTicket,
  listTicketEvents,
  listTicketLinks,
} from "./ticket-events.js";
import { createTicket } from "./ticket-writes.js";
import { getTicket } from "./tickets.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
const a = unwrap(
  await createTicket(t.db, newTicketInput({ title: "a" }), OPERATOR),
);
const b = unwrap(
  await createTicket(t.db, newTicketInput({ title: "b" }), OPERATOR),
);

const validation = { ok: false, error: { class: "validation" } };
const events = async (ticketId: string) =>
  unwrap(
    await listTicketEvents(t.db, { ticket_id: ticketId, since: 0, limit: 100 }),
  ).rows;

test("appendTicketEvent stores a note with its actor and canonical JSON payload, without a version bump", async () => {
  const row = unwrap(
    await appendTicketEvent(t.db, {
      ticket_id: a.id,
      kind: "comment",
      actor_kind: "session",
      actor_id: "s-1",
      reason: "fyi",
      payload: { z: 1, a: [true] },
    }),
  );
  expect(row).toEqual({
    id: expect.any(Number),
    ticket_id: a.id,
    ts: clock.now(),
    kind: "comment",
    actor_kind: "session",
    actor_id: "s-1",
    from_status: null,
    to_status: null,
    reason: "fyi",
    payload_json: '{"a":[true],"z":1}',
  });
  expect(unwrap(await getTicket(t.db, a.id)).version).toBe(1);
});

test("appendTicketEvent refuses the kinds other writers own, an empty kind or actor, and a non-JSON payload", async () => {
  for (const kind of ["created", "updated", "transition", "linked", ""]) {
    expect(
      await appendTicketEvent(t.db, { ticket_id: a.id, kind, ...OPERATOR }),
      kind,
    ).toMatchObject(validation);
  }
  expect(
    await appendTicketEvent(t.db, {
      ticket_id: a.id,
      kind: "comment",
      actor_kind: "",
      actor_id: null,
    }),
  ).toMatchObject(validation);
  expect(
    await appendTicketEvent(t.db, {
      ticket_id: a.id,
      kind: "comment",
      ...OPERATOR,
      payload: { n: 1n },
    }),
  ).toMatchObject(validation);
});

test("appendTicketEvent on an unknown ticket is a validation error (its foreign key)", async () => {
  expect(
    await appendTicketEvent(t.db, {
      ticket_id: "nope",
      kind: "comment",
      ...OPERATOR,
    }),
  ).toMatchObject(validation);
});

test("linkTicket stores a ticket or url link and records who linked it", async () => {
  const toTicket = unwrap(
    await linkTicket(
      t.db,
      { ticket_id: a.id, kind: "blocks", target_ticket_id: b.id },
      OPERATOR,
    ),
  );
  const toUrl = unwrap(
    await linkTicket(
      t.db,
      { ticket_id: a.id, kind: "pr", url: "https://example.test/pr/1" },
      { ...OPERATOR, reason: "opened" },
    ),
  );
  expect(toTicket).toEqual({
    ticket_id: a.id,
    kind: "blocks",
    url: null,
    target_ticket_id: b.id,
    created_at: clock.now(),
  });
  expect(toUrl).toMatchObject({
    url: "https://example.test/pr/1",
    target_ticket_id: null,
  });
  expect(unwrap(await listTicketLinks(t.db, a.id))).toEqual([toTicket, toUrl]);
  expect(unwrap(await listTicketLinks(t.db, b.id))).toEqual([]);
  const linked = (await events(a.id)).filter((e) => e.kind === "linked");
  expect(linked).toMatchObject([
    {
      actor_kind: "operator",
      payload_json: `{"kind":"blocks","target_ticket_id":"${b.id}"}`,
    },
    {
      reason: "opened",
      payload_json: '{"kind":"pr","url":"https://example.test/pr/1"}',
    },
  ]);
});

test("linkTicket needs a kind and a url or a target; a ticket cannot link to itself", async () => {
  for (const link of [
    { ticket_id: a.id, kind: "pr" },
    { ticket_id: a.id, kind: "", url: "https://example.test" },
    { ticket_id: a.id, kind: "blocks", target_ticket_id: a.id },
  ]) {
    expect(
      await linkTicket(t.db, link, OPERATOR),
      JSON.stringify(link),
    ).toMatchObject(validation);
  }
});

test("listTicketEvents pages after an exclusive cursor, for one ticket or all of them", async () => {
  const all = unwrap(await listTicketEvents(t.db, { since: 0, limit: 1000 }));
  const ids = all.rows.map((e) => e.id);
  expect(ids).toEqual(ids.toSorted((x, y) => x - y));
  expect(all.hasMore).toBe(false);

  const page = unwrap(await listTicketEvents(t.db, { since: 0, limit: 2 }));
  expect(page).toEqual({
    rows: all.rows.slice(0, 2),
    nextCursor: ids[1],
    hasMore: true,
  });
  const rest = unwrap(
    await listTicketEvents(t.db, { since: page.nextCursor, limit: 1000 }),
  );
  expect(rest.rows).toEqual(all.rows.slice(2));

  const onlyB = await events(b.id);
  expect(onlyB.length).toBeGreaterThan(0);
  expect(onlyB.every((e) => e.ticket_id === b.id)).toBe(true);
  const end = unwrap(
    await listTicketEvents(t.db, { since: ids.at(-1) ?? 0, limit: 10 }),
  );
  expect(end).toEqual({ rows: [], nextCursor: ids.at(-1), hasMore: false });
});

test("listTicketEvents refuses a bad cursor or limit", async () => {
  for (const query of [
    { since: -1, limit: 10 },
    { since: 0, limit: 0 },
    { since: 0, limit: 1001 },
  ]) {
    expect(
      await listTicketEvents(t.db, query),
      JSON.stringify(query),
    ).toMatchObject(validation);
  }
});
