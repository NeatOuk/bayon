import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { FakeClock, type FrmError } from "@bayon/core";
import {
  SUPERVISOR_RUNNER_TYPE,
  getRun,
  getRunSpend,
  getSession,
  type EventRow,
} from "@bayon/db";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { rawLogPath } from "../paths.js";
import {
  countingInsert,
  ingestHarness,
  texts,
} from "../testing/ingest-harness.js";
import { createIngest } from "./ingest.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
const home = mkdtempSync("/tmp/frm-");
afterAll(() => {
  t.cleanup();
  rmSync(home, { recursive: true, force: true });
});
const log = pino({ level: "silent" });
const h = ingestHarness({
  db: t.db,
  home,
  sessionInput: newSessionInput,
  runInput: newRunInput,
});

/** What must match between two sessions fed the same script (their ids differ). */
const shape = (rows: readonly EventRow[]) =>
  rows.map((r) => [
    r.kind,
    r.runner_type,
    r.raw_offset,
    r.text,
    r.run_id !== null,
  ]);

/** The start of every record in a raw log: where a fresh mapper puts each fixture event. */
function recordOffsets(path: string): number[] {
  const raw = readFileSync(path);
  const starts = [0];
  raw.forEach((byte, i) => {
    if (byte === 0x0a && i + 1 < raw.length) starts.push(i + 1);
  });
  return raw.length === 0 ? [] : starts;
}

test("5 000 events ingest in one process in ≤ 60 transactions", async () => {
  const counter = countingInsert();
  const ingest = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: counter.insert,
  });
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, {
    runs: [{ events: texts(4_998) }],
  });
  const before = t.db.stats.txns;
  const run = await h.send(ingest, s);
  expect(await ingest.terminalOf(run)).toBe("ok");
  await h.adapter.stop(s.handle, "graceful");
  await s.attachment.closed;
  const txns = t.db.stats.txns - before;

  expect(await h.stored(sessionId)).toHaveLength(5_000);
  expect(counter.stats).toEqual({ calls: 50, rows: 5_000 });
  expect(txns).toBeLessThanOrEqual(60);
  console.info(
    `[evidence] 5000 events: ${counter.stats.calls} insertEventsBatch transactions; ` +
      `${txns} write transactions in all (appendRun, openRun, 50 batches, finishRun, spend)`,
  );
}, 60_000);

test("a crash before a batch commits, then replay: no duplicates, identical counts", async () => {
  const script = { runs: [{ events: texts(248) }] };
  const reference = createIngest({ db: t.db, clock, log });
  const refId = await h.session();
  const ref = await h.start(reference, refId, script);
  const refRun = await h.send(reference, ref);
  await reference.terminalOf(refRun);
  await h.adapter.stop(ref.handle, "graceful");
  await ref.attachment.closed;

  // The third batch holds the terminal: it throws before its transaction commits.
  const fatal: FrmError[] = [];
  const crashing = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: countingInsert({ crashOn: 3 }).insert,
    onFatal: (e) => fatal.push(e),
  });
  const victim = await h.session();
  const v = await h.start(crashing, victim, script);
  const run = await h.send(crashing, v);
  await expect(v.attachment.closed).rejects.toMatchObject({
    class: "internal",
  });
  await h.adapter.stop(v.handle, "kill");
  expect(fatal).toHaveLength(1);
  expect(await h.stored(victim)).toHaveLength(200);
  expect(unwrap(await getRun(t.db, run)).state).toBe("running");

  // A fresh process replays from raw_segment_offset; it inserts only what never committed.
  const counter = countingInsert();
  const fresh = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: counter.insert,
  });
  const { endOffset } = unwrap(await fresh.replay(victim, h.adapter));
  expect(endOffset).toBe(readFileSync(rawLogPath(home, victim)).length);
  expect(counter.stats.rows).toBe(50);
  const rows = await h.stored(victim);
  expect(shape(rows)).toEqual(shape(await h.stored(refId)));
  expect(rows.every((r) => r.run_id === run)).toBe(true);
  expect(unwrap(await getRun(t.db, run)).state).toBe("ok");
  expect(await fresh.terminalOf(run)).toBe("ok");
  const spend = unwrap(await getRunSpend(t.db, run));
  const refSpend = unwrap(await getRunSpend(t.db, refRun));
  expect(spend).toMatchObject({
    tokens_in: refSpend?.tokens_in,
    cost_usd: refSpend?.cost_usd,
  });
  const counts = (s: {
    turns: number;
    tool_calls: number;
    tokens_in: number | null;
    cost_usd: number;
  }) => [s.turns, s.tool_calls, s.tokens_in, s.cost_usd];
  expect(counts(unwrap(await getSession(t.db, victim)))).toEqual(
    counts(unwrap(await getSession(t.db, refId))),
  );

  // Replaying again is a no-op.
  unwrap(await fresh.replay(victim, h.adapter));
  expect(await h.stored(victim)).toHaveLength(250);
}, 30_000);

test("a crash mid-stream: replay restores what reached the raw log; closeRun ends the run", async () => {
  const crashing = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: countingInsert({ crashOn: 2 }).insert,
    onFatal: () => undefined,
  });
  const sessionId = await h.session();
  const s = await h.start(crashing, sessionId, {
    runs: [{ events: texts(498) }],
  });
  const run = await h.send(crashing, s);
  await expect(s.attachment.closed).rejects.toMatchObject({
    class: "internal",
  });
  await h.adapter.stop(s.handle, "kill");
  expect(await h.stored(sessionId)).toHaveLength(100);

  const fresh = createIngest({ db: t.db, clock, log });
  unwrap(await fresh.replay(sessionId, h.adapter));
  const rows = await h.stored(sessionId);
  expect(rows.map((r) => r.raw_offset)).toEqual(
    recordOffsets(rawLogPath(home, sessionId)),
  );
  expect(rows.length).toBeGreaterThan(100);
  expect(unwrap(await getRun(t.db, run)).state).toBe("running");

  const close = {
    outcome: "interrupted",
    errorClass: "interrupted",
    message: "supervisor restarted",
  } as const;
  unwrap(await fresh.closeRun(sessionId, run, close));
  expect(await fresh.terminalOf(run)).toBe("interrupted");
  expect((await h.stored(sessionId)).at(-1)).toMatchObject({
    kind: "terminal",
    runner_type: SUPERVISOR_RUNNER_TYPE,
    raw_offset: -1,
  });
  expect(unwrap(await getRun(t.db, run)).state).toBe("interrupted");
}, 30_000);

test("replay rebuilds the mapper from raw_segment_offset, not from the log's start", async () => {
  const spend = (cost_usd: number) => ({
    tokens_in: 10,
    tokens_out: 1,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost_usd,
  });
  const script = {
    runs: [
      { events: texts(1), spend: spend(0.001) },
      { events: texts(120), spend: spend(0.004) },
    ],
  };
  const first = createIngest({ db: t.db, clock, log });
  const sessionId = await h.session();
  const one = await h.start(first, sessionId, script);
  await first.terminalOf(await h.send(first, one));
  await h.adapter.stop(one.handle, "graceful");
  await one.attachment.closed;
  const runnerSessionId = one.handle.runnerSessionId ?? "";

  // Segment 2: an adopted process, whose running totals restart at zero. It crashes on the
  // batch that holds its terminal.
  const crashing = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: countingInsert({ crashOn: 2 }).insert,
    onFatal: () => undefined,
  });
  const two = await h.start(crashing, sessionId, script, {
    resume: runnerSessionId,
  });
  expect(two.offset).toBeGreaterThan(one.offset);
  const run2 = await h.send(crashing, two);
  await expect(two.attachment.closed).rejects.toMatchObject({
    class: "internal",
  });
  await h.adapter.stop(two.handle, "kill");

  const fresh = createIngest({ db: t.db, clock, log });
  unwrap(await fresh.replay(sessionId, h.adapter));
  expect(unwrap(await getRun(t.db, run2)).state).toBe("ok");
  // Segment 2's own delta; mapping from byte 0 would bill 0.004 − 0.001.
  expect(unwrap(await getRunSpend(t.db, run2))?.cost_usd).toBe(0.004);
}, 30_000);
