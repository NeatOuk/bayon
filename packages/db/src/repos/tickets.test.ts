import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  OPERATOR,
  SPINE_SEED,
  newTicketInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { listTicketEvents } from "./ticket-events.js";
import {
  createTicket,
  updateTicketCas,
  type NewTicket,
  type TicketPatch,
} from "./ticket-writes.js";
import {
  getTicket,
  getTicketByNum,
  listTickets,
  type TicketQuery,
} from "./tickets.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
afterAll(() => t.cleanup());

const SESSION = {
  actor_kind: "session",
  actor_id: SPINE_SEED.sessionId,
} as const;
const validation = { ok: false, error: { class: "validation" } };
const notFound = { ok: false, error: { class: "not_found" } };

const events = async (ticketId: string) =>
  unwrap(
    await listTicketEvents(t.db, { ticket_id: ticketId, since: 0, limit: 100 }),
  ).rows;

test("createTicket numbers from the highest num, starts at version 1 and records its creator", async () => {
  unwrap(await seedRows(t.db, { tickets: [ticketRow(41)] }));
  const now = clock.now();
  const a = unwrap(
    await createTicket(t.db, newTicketInput({ title: "first" }), OPERATOR),
  );
  const b = unwrap(
    await createTicket(t.db, newTicketInput({ title: "second" }), SESSION),
  );
  expect([a.num, b.num]).toEqual([42, 43]);
  expect(a).toMatchObject({
    title: "first",
    status: "backlog",
    version: 1,
    created_at: now,
    updated_at: now,
    closed_at: null,
    cost_usd: 0,
  });
  expect(await events(a.id)).toEqual([
    expect.objectContaining({
      kind: "created",
      from_status: null,
      to_status: "backlog",
      actor_kind: "operator",
      actor_id: OPERATOR.actor_id,
      ts: now,
    }),
  ]);
  expect(await events(b.id)).toEqual([
    expect.objectContaining({
      kind: "created",
      actor_kind: "session",
      actor_id: SPINE_SEED.sessionId,
    }),
  ]);
});

test("createTicket refuses managed and derived columns (amendment 9) and an empty actor", async () => {
  for (const extra of [
    { num: 7 },
    { version: 3 },
    { cost_usd: 1 },
    { cost_wasted_usd: 1 },
    { review_rounds: 2 },
    { handoff_count: 1 },
  ]) {
    const input = { ...newTicketInput(), ...extra } as unknown as NewTicket;
    expect(
      await createTicket(t.db, input, OPERATOR),
      JSON.stringify(extra),
    ).toMatchObject(validation);
  }
  expect(
    await createTicket(t.db, newTicketInput(), {
      actor_kind: "",
      actor_id: null,
    }),
  ).toMatchObject(validation);
});

test("getTicket and getTicketByNum read a ticket back; unknown ones are not_found", async () => {
  const created = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  expect(unwrap(await getTicket(t.db, created.id))).toEqual(created);
  expect(unwrap(await getTicketByNum(t.db, created.num))).toEqual(created);
  expect(await getTicket(t.db, "nope")).toMatchObject(notFound);
  expect(await getTicketByNum(t.db, 999_999)).toMatchObject(notFound);
});

test("updateTicketCas applies the patch, bumps the version and records which fields changed", async () => {
  const created = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  await clock.advance(1000);
  const updated = unwrap(
    await updateTicketCas(t.db, {
      id: created.id,
      version: 1,
      patch: { title: "renamed", priority: 1 },
      by: { ...SESSION, reason: "clearer" },
    }),
  );
  expect(updated).toEqual({
    ...created,
    title: "renamed",
    priority: 1,
    version: 2,
    updated_at: clock.now(),
  });
  expect((await events(created.id)).at(-1)).toMatchObject({
    kind: "updated",
    actor_kind: "session",
    actor_id: SPINE_SEED.sessionId,
    reason: "clearer",
    from_status: null,
    to_status: null,
    payload_json: '{"fields":["priority","title"]}',
    ts: clock.now(),
  });
});

test("updateTicketCas at a stale version is a conflict naming the current version, and changes nothing", async () => {
  const { id } = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  unwrap(
    await updateTicketCas(t.db, {
      id,
      version: 1,
      patch: { title: "a" },
      by: OPERATOR,
    }),
  );
  const stale = await updateTicketCas(t.db, {
    id,
    version: 1,
    patch: { title: "b" },
    by: OPERATOR,
  });
  expect(stale).toMatchObject({
    ok: false,
    error: { class: "conflict", cause: { current_version: 2 } },
  });
  expect(unwrap(await getTicket(t.db, id))).toMatchObject({
    title: "a",
    version: 2,
  });
  expect((await events(id)).map((e) => e.kind)).toEqual(["created", "updated"]);
});

test("updateTicketCas on an unknown ticket is not_found", async () => {
  expect(
    await updateTicketCas(t.db, {
      id: "nope",
      version: 1,
      patch: { title: "x" },
      by: OPERATOR,
    }),
  ).toMatchObject(notFound);
});

test("updateTicketCas refuses an empty patch, status, managed or derived columns, and a bad version", async () => {
  const { id } = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  const cases: [string, TicketPatch, number][] = [
    ["empty", {}, 1],
    ["status", { status: "done" } as unknown as TicketPatch, 1],
    ["num", { num: 9 } as unknown as TicketPatch, 1],
    ["cost_usd", { cost_usd: 3 } as unknown as TicketPatch, 1],
    ["version 0", { title: "x" }, 0],
    ["version 1.5", { title: "x" }, 1.5],
  ];
  for (const [name, patch, version] of cases) {
    expect(
      await updateTicketCas(t.db, { id, version, patch, by: OPERATOR }),
      name,
    ).toMatchObject(validation);
  }
  expect(unwrap(await getTicket(t.db, id)).version).toBe(1);
});

// A board of four tickets, numbered 1 to 4, for the list and search tests.
const board = unwrap(await tempDb(clock));
afterAll(() => board.cleanup());
for (const input of [
  newTicketInput({ title: "Login redirect loops" }),
  newTicketInput({
    title: "Exporter",
    body_md: "rebuild the login index",
    status: "prioritized",
    needs_human: 1,
  }),
  newTicketInput({
    title: "Budget strip",
    status: "prioritized",
    complexity_tier: "complex",
  }),
  newTicketInput({ title: "Ticket board", status: "done" }),
]) {
  unwrap(await createTicket(board.db, input, OPERATOR));
}

const titles = async (q: Omit<TicketQuery, "limit">) =>
  unwrap(await listTickets(board.db, { ...q, limit: 50 })).rows.map(
    (row) => row.title,
  );

test("listTickets filters by status, needs_human and tier, in num order", async () => {
  expect(await titles({})).toEqual([
    "Login redirect loops",
    "Exporter",
    "Budget strip",
    "Ticket board",
  ]);
  expect(await titles({ status: ["prioritized"] })).toEqual([
    "Exporter",
    "Budget strip",
  ]);
  expect(await titles({ status: ["backlog", "done"] })).toEqual([
    "Login redirect loops",
    "Ticket board",
  ]);
  expect(await titles({ needs_human: true })).toEqual(["Exporter"]);
  expect(await titles({ needs_human: false })).toEqual([
    "Login redirect loops",
    "Budget strip",
    "Ticket board",
  ]);
  expect(await titles({ complexity_tier: "complex" })).toEqual([
    "Budget strip",
  ]);
});

test("listTickets q searches titles and bodies through tickets_fts; user text is never FTS syntax", async () => {
  expect(await titles({ q: "login" })).toEqual([
    "Login redirect loops",
    "Exporter",
  ]);
  expect(await titles({ q: "login redirect" })).toEqual([
    "Login redirect loops",
  ]);
  expect(await titles({ q: "LOGIN", status: ["prioritized"] })).toEqual([
    "Exporter",
  ]);
  expect(await titles({ q: 'title:login OR "unbalanced' })).toEqual([]);
  expect(await titles({ q: "!!!" })).toEqual([]);
  expect(await titles({ q: "absent" })).toEqual([]);
});

test("listTickets pages by num after an exclusive cursor", async () => {
  const first = unwrap(await listTickets(board.db, { limit: 3 }));
  expect(first.rows.map((row) => row.num)).toEqual([1, 2, 3]);
  expect(first).toMatchObject({ nextCursor: 3, hasMore: true });
  const rest = unwrap(
    await listTickets(board.db, { limit: 3, after_num: first.nextCursor }),
  );
  expect(rest.rows.map((row) => row.num)).toEqual([4]);
  expect(rest).toMatchObject({ nextCursor: 4, hasMore: false });
  const none = unwrap(await listTickets(board.db, { limit: 3, after_num: 4 }));
  expect(none).toEqual({ rows: [], nextCursor: 4, hasMore: false });
});

test("listTickets refuses a bad query", async () => {
  for (const query of [
    { limit: 0 },
    { limit: 1001 },
    { limit: 10, after_num: -1 },
    { limit: 10, q: "   " },
    { limit: 10, status: [] },
  ]) {
    expect(
      await listTickets(board.db, query),
      JSON.stringify(query),
    ).toMatchObject(validation);
  }
});
