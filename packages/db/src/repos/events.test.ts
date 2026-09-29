import { FakeClock, type EventKind } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import {
  getEventsSince,
  insertEventsBatch,
  toCanonical,
  type EventInsert,
} from "./events.js";
import { appendRun } from "./runs.js";
import { createSession, getSession } from "./sessions.js";

const T0 = 1_700_000_000_000;
const t = unwrap(await tempDb(new FakeClock(T0)));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));

const KINDS: readonly EventKind[] = [
  "turn_start",
  "tool_call",
  "tool_result",
  "command",
  "mcp_call",
  "assistant_text",
  "turn_end",
  "usage",
];

/** A fresh session with one run, so each test counts from zero. */
async function spine() {
  const session = unwrap(await createSession(t.db, newSessionInput()));
  const run = unwrap(await appendRun(t.db, newRunInput(session.id)));
  return { sessionId: session.id, runId: run.id };
}

type Spine = Awaited<ReturnType<typeof spine>>;

const events = (s: Spine, from: number, to: number): EventInsert[] =>
  Array.from({ length: to - from }, (_, n) => {
    const i = from + n;
    return {
      session_id: s.sessionId,
      run_id: s.runId,
      ts: T0 + i,
      kind: KINDS[i % KINDS.length] ?? "usage",
      runner_type: "fixture.line",
      payload_json: "{}",
      raw_offset: i * 100,
    };
  });

const counts = (rows: readonly EventInsert[]) => ({
  turns: rows.filter((r) => r.kind === "turn_end").length,
  // Payloads name no call id, so every command here is bare and counts.
  toolCalls: rows.filter((r) =>
    ["tool_call", "command", "mcp_call"].includes(r.kind),
  ).length,
});

/** One event of a tool call, with its call id in the payload (or none). */
const callEvent = (
  s: Spine,
  kind: EventKind,
  callId: string | undefined,
  offset: number,
): EventInsert => ({
  session_id: s.sessionId,
  run_id: s.runId,
  ts: T0 + offset,
  kind,
  runner_type: "fixture.line",
  payload_json: JSON.stringify(callId === undefined ? {} : { call_id: callId }),
  raw_offset: offset,
});

const runToolCalls = (runId: string) =>
  raw.prepare("SELECT tool_calls FROM runs WHERE id = ?").pluck().get(runId);

const allEvents = async (sessionId: string) =>
  unwrap(await getEventsSince(t.db, { sessionId, since: 0, limit: 1000 })).rows;

test("a 500-row batch is one transaction", async () => {
  const s = await spine();
  const txns = t.db.stats.txns;
  const result = unwrap(await insertEventsBatch(t.db, events(s, 0, 500)));
  expect(t.db.stats.txns).toBe(txns + 1);
  const stored = await allEvents(s.sessionId);
  expect(stored).toHaveLength(500);
  expect(result).toEqual({ inserted: 500, lastId: stored.at(-1)?.id });
});

test("a poisoned last row or a NULL raw_offset persists nothing", async () => {
  const s = await spine();
  const rows = events(s, 0, 500);
  const last = rows[499];
  if (!last) throw new Error("fixture has 500 rows");
  const poisoned = [
    ...rows.slice(0, 499),
    { ...last, session_id: "no-such-session" },
  ];
  expect(await insertEventsBatch(t.db, poisoned)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  // A caller outside TypeScript can still send null; it must not reach the unique key.
  const nullOffset = [
    ...rows.slice(0, 499),
    { ...last, raw_offset: null as unknown as number },
  ];
  expect(await insertEventsBatch(t.db, nullOffset)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(await allEvents(s.sessionId)).toEqual([]);
  expect(unwrap(await getSession(t.db, s.sessionId))).toMatchObject({
    turns: 0,
    tool_calls: 0,
    last_event_at: null,
  });
});

test("replays are idempotent on (session_id, runner_type, raw_offset); counters move only for new rows", async () => {
  const s = await spine();
  const first = events(s, 0, 500);
  unwrap(await insertEventsBatch(t.db, first));
  const expected = counts(first);
  const afterFirst = unwrap(await getSession(t.db, s.sessionId));
  expect(afterFirst).toMatchObject({
    turns: expected.turns,
    tool_calls: expected.toolCalls,
    last_event_at: T0 + 499,
  });
  expect(runToolCalls(s.runId)).toBe(expected.toolCalls);

  expect(unwrap(await insertEventsBatch(t.db, first))).toEqual({
    inserted: 0,
    lastId: null,
  });
  expect(unwrap(await getSession(t.db, s.sessionId))).toEqual(afterFirst);

  const overlap = unwrap(await insertEventsBatch(t.db, events(s, 250, 750)));
  expect(overlap.inserted).toBe(250);
  const added = counts(events(s, 500, 750));
  expect(unwrap(await getSession(t.db, s.sessionId))).toMatchObject({
    turns: expected.turns + added.turns,
    tool_calls: expected.toolCalls + added.toolCalls,
    last_event_at: T0 + 749,
  });
  expect(runToolCalls(s.runId)).toBe(expected.toolCalls + added.toolCalls);
  expect(await allEvents(s.sessionId)).toHaveLength(750);
});

const toolCallsOf = async (s: Spine) => [
  unwrap(await getSession(t.db, s.sessionId)).tool_calls,
  runToolCalls(s.runId),
];

test("a call reported as tool_call and command counts once, in one batch, across two, and on replay", async () => {
  const s = await spine();
  const together = [
    callEvent(s, "tool_call", "c1", 0),
    callEvent(s, "tool_result", "c1", 1),
    callEvent(s, "command", "c1", 2),
  ];
  unwrap(await insertEventsBatch(t.db, together));
  expect(await toolCallsOf(s)).toEqual([1, 1]);
  const call = callEvent(s, "tool_call", "c2", 10);
  const command = callEvent(s, "command", "c2", 12);
  unwrap(await insertEventsBatch(t.db, [call]));
  unwrap(await insertEventsBatch(t.db, [command]));
  expect(await toolCallsOf(s)).toEqual([2, 2]);
  expect(
    unwrap(await insertEventsBatch(t.db, [...together, call, command])),
  ).toEqual({ inserted: 0, lastId: null });
  expect(await toolCallsOf(s)).toEqual([2, 2]);
});

test("a bare command counts once: no call id, or no tool_call of its id in its own session", async () => {
  const s = await spine();
  const other = await spine();
  unwrap(
    await insertEventsBatch(t.db, [callEvent(other, "tool_call", "c9", 0)]),
  );
  const rows = [
    // A malformed tool_call is stored and counted, and the pairing lookup reads past it.
    { ...callEvent(s, "tool_call", undefined, 0), payload_json: "{not json" },
    callEvent(s, "command", undefined, 1),
    callEvent(s, "mcp_call", "c9", 2),
    callEvent(s, "command", "c9", 3), // pairs with a tool_call only, never an mcp_call
  ];
  unwrap(await insertEventsBatch(t.db, rows));
  expect(await toolCallsOf(s)).toEqual([4, 4]);
  unwrap(await insertEventsBatch(t.db, rows));
  expect(await toolCallsOf(s)).toEqual([4, 4]);
});

test("a replayed frm.supervisor terminal dedupes on raw_offset = -runs.seq", async () => {
  const s = await spine();
  const terminal: EventInsert = {
    session_id: s.sessionId,
    run_id: s.runId,
    ts: T0,
    kind: "terminal",
    runner_type: "frm.supervisor",
    payload_json: JSON.stringify({ outcome: "failed" }),
    raw_offset: -1, // the run's seq is 1
  };
  expect(unwrap(await insertEventsBatch(t.db, [terminal])).inserted).toBe(1);
  expect(unwrap(await insertEventsBatch(t.db, [terminal])).inserted).toBe(0);
  const second = { ...terminal, raw_offset: -2 };
  expect(unwrap(await insertEventsBatch(t.db, [second])).inserted).toBe(1);
});

test.each([
  ["a negative raw_offset from a runner", { raw_offset: -1 }],
  ["a fractional raw_offset", { raw_offset: 1.5 }],
  [
    "a fractional frm.supervisor raw_offset",
    { runner_type: "frm.supervisor", raw_offset: -1.5 },
  ],
])("%s is a validation error", async (_, override) => {
  const s = await spine();
  const [row] = events(s, 0, 1);
  if (!row) throw new Error("fixture has one row");
  expect(
    await insertEventsBatch(t.db, [{ ...row, ...override }]),
  ).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("an older batch leaves last_event_at alone", async () => {
  const s = await spine();
  unwrap(await insertEventsBatch(t.db, events(s, 100, 110)));
  const older = events(s, 0, 10);
  unwrap(await insertEventsBatch(t.db, older));
  expect(unwrap(await getSession(t.db, s.sessionId)).last_event_at).toBe(
    T0 + 109,
  );
});

test("an empty batch writes nothing", async () => {
  const txns = t.db.stats.txns;
  expect(unwrap(await insertEventsBatch(t.db, []))).toEqual({
    inserted: 0,
    lastId: null,
  });
  expect(t.db.stats.txns).toBe(txns);
});

test("getEventsSince pages on an exclusive events.id cursor", async () => {
  const s = await spine();
  unwrap(await insertEventsBatch(t.db, events(s, 0, 5)));
  const ids = (await allEvents(s.sessionId)).map((e) => e.id);
  const page = async (since: number) =>
    unwrap(
      await getEventsSince(t.db, { sessionId: s.sessionId, since, limit: 2 }),
    );

  const one = await page(0);
  expect([one.rows.map((e) => e.id), one.nextCursor, one.hasMore]).toEqual([
    ids.slice(0, 2),
    ids[1],
    true,
  ]);
  const two = await page(one.nextCursor);
  expect([two.rows.map((e) => e.id), two.hasMore]).toEqual([
    ids.slice(2, 4),
    true,
  ]);
  const three = await page(two.nextCursor);
  expect([three.rows.map((e) => e.id), three.hasMore]).toEqual([
    ids.slice(4),
    false,
  ]);
  const done = await page(three.nextCursor);
  expect(done).toEqual({
    rows: [],
    nextCursor: three.nextCursor,
    hasMore: false,
  });
});

test("getEventsSince filters by kind", async () => {
  const s = await spine();
  unwrap(await insertEventsBatch(t.db, events(s, 0, 16)));
  const turnEnds = unwrap(
    await getEventsSince(t.db, {
      sessionId: s.sessionId,
      since: 0,
      kinds: ["turn_end", "usage"],
      limit: 100,
    }),
  );
  expect(turnEnds.rows.map((e) => e.kind)).toEqual([
    "turn_end",
    "usage",
    "turn_end",
    "usage",
  ]);
});

test.each([
  ["limit 0", { limit: 0 }],
  ["limit 1001", { limit: 1001 }],
  ["a fractional limit", { limit: 1.5 }],
  ["a negative cursor", { since: -1 }],
  ["an empty kinds list", { kinds: [] }],
])("getEventsSince rejects %s", async (_, override) => {
  const query = { sessionId: "any", since: 0, limit: 10, ...override };
  expect(await getEventsSince(t.db, query)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("toCanonical drops NULL columns and parses the payload", async () => {
  const s = await spine();
  unwrap(
    await insertEventsBatch(t.db, [
      {
        session_id: s.sessionId,
        ts: T0,
        kind: "tool_call",
        runner_type: "fixture.tool_use",
        tool_name: "Read",
        payload_json: JSON.stringify({
          call_id: "c1",
          input: { path: "a.ts" },
        }),
        raw_offset: 0,
      },
    ]),
  );
  const [row] = await allEvents(s.sessionId);
  if (!row) throw new Error("one event was inserted");
  const event = toCanonical(row);
  expect(event).toEqual({
    id: row.id,
    kind: "tool_call",
    ts: T0,
    runner_type: "fixture.tool_use",
    tool_name: "Read",
    payload: { call_id: "c1", input: { path: "a.ts" } },
  });
  expect(Object.values(event)).not.toContain(null);
});

test("toCanonical keeps an unparseable row as runner_native", async () => {
  const s = await spine();
  unwrap(
    await insertEventsBatch(t.db, [
      {
        session_id: s.sessionId,
        ts: T0,
        kind: "tool_call",
        runner_type: "fixture.tool_use",
        payload_json: "{not json",
        raw_offset: 0,
      },
      {
        session_id: s.sessionId,
        ts: T0,
        kind: "turn_start",
        runner_type: "fixture.turn",
        raw_offset: 1,
      },
    ]),
  );
  const [broken, bare] = (await allEvents(s.sessionId)).map(toCanonical);
  expect(broken).toMatchObject({
    kind: "runner_native",
    ts: T0,
    runner_type: "fixture.tool_use",
    payload: { raw: { kind: "tool_call", payload: "{not json" } },
  });
  expect(bare).toMatchObject({ kind: "turn_start", payload: {} });
});
