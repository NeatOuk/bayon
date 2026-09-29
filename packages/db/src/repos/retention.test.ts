import { FakeClock, type SessionState } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  appendEvents,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { insertEventsBatch } from "./events.js";
import {
  deleteArchivedEvents,
  listArchivableEvents,
  type ArchivableQuery,
} from "./retention.js";

// Event retention's reads and deletes: which events a sweep may archive.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 14, 4);
const t = unwrap(await tempDb(new FakeClock(NOW)));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 12));

const session = (id: string, ticket: string, state: SessionState) => ({
  ...newSessionInput(),
  id,
  ticket_id: ticket,
  state,
  created_at: 0,
});
unwrap(
  await seedRows(t.db, {
    tickets: [
      ticketRow(1, { status: "done", closed_at: NOW - 40 * DAY }),
      ticketRow(2, { status: "done", closed_at: NOW - 10 * DAY }),
      ticketRow(3, { status: "building" }),
      ticketRow(4, { status: "rejected", closed_at: NOW - 31 * DAY }),
    ],
    sessions: [
      session("s-old", "ticket-1", "exited"),
      session("s-recent", "ticket-2", "exited"),
      session("s-open", "ticket-3", "exited"),
      session("s-resumable", "ticket-1", "resumable"),
      session("s-rejected", "ticket-4", "handed_off"),
    ],
  }),
);
const ids = {
  old: unwrap(await appendEvents(t.db, "s-old", 3)),
  recent: unwrap(await appendEvents(t.db, "s-recent", 2)),
  open: unwrap(await appendEvents(t.db, "s-open", 2)),
  resumable: unwrap(await appendEvents(t.db, "s-resumable", 2)),
  rejected: unwrap(await appendEvents(t.db, "s-rejected", 2)),
};
const reasoning = unwrap(
  await insertEventsBatch(t.db, [
    {
      session_id: "s-old",
      ts: NOW,
      kind: "reasoning",
      runner_type: "thinking",
      text: "why",
      raw_offset: 100,
    },
  ]),
).lastId;

const query = (o: Partial<ArchivableQuery> = {}): ArchivableQuery => ({
  closedBefore: NOW - 30 * DAY,
  includeReasoning: false,
  afterId: 0,
  limit: 100,
  ...o,
});

test("only events of tickets closed before the cutoff, from sessions ended for good, reasoning kept", async () => {
  const rows = unwrap(await listArchivableEvents(t.db, query()));
  expect(rows.map((r) => r.id)).toEqual([...ids.old, ...ids.rejected]);
  expect(rows[0]).toMatchObject({ session_id: "s-old", ticket_id: "ticket-1" });
  const withReasoning = unwrap(
    await listArchivableEvents(t.db, query({ includeReasoning: true })),
  );
  expect(withReasoning.map((r) => r.id)).toEqual(
    [...ids.old, ...ids.rejected, reasoning].toSorted(
      (a, b) => (a ?? 0) - (b ?? 0),
    ),
  );
});

test("pages by id with afterId and limit; a bad query is refused", async () => {
  const first = unwrap(await listArchivableEvents(t.db, query({ limit: 2 })));
  expect(first.map((r) => r.id)).toEqual(ids.old.slice(0, 2));
  const next = unwrap(
    await listArchivableEvents(
      t.db,
      query({ afterId: first.at(-1)?.id ?? 0, limit: 2 }),
    ),
  );
  expect(next.map((r) => r.id)).toEqual([ids.old[2], ids.rejected[0]]);
  expect(await listArchivableEvents(t.db, query({ limit: 0 }))).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("deletes a batch in one transaction; again, nothing", async () => {
  const batch = unwrap(await listArchivableEvents(t.db, query()));
  const before = t.db.stats.txns;
  expect(
    unwrap(
      await deleteArchivedEvents(
        t.db,
        batch.map((r) => r.id),
      ),
    ),
  ).toBe(5);
  expect(t.db.stats.txns).toBe(before + 1);
  expect(
    unwrap(
      await deleteArchivedEvents(
        t.db,
        batch.map((r) => r.id),
      ),
    ),
  ).toBe(0);
  expect(unwrap(await listArchivableEvents(t.db, query()))).toEqual([]);
  expect(unwrap(await deleteArchivedEvents(t.db, []))).toBe(0);
  expect(await deleteArchivedEvents(t.db, [1.5])).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  // The other sessions' events are untouched.
  const kept = unwrap(
    await listArchivableEvents(
      t.db,
      query({ closedBefore: NOW, includeReasoning: true }),
    ),
  );
  expect(kept.map((r) => r.id)).toEqual([...ids.recent, reasoning]);
});
