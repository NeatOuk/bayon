// Raw-log durability (§9.4, M4 amendment). No row that points into a raw log commits
// before its bytes are fdatasync'd (live, replay, segment roll), and a new segment starts at
// max(file size, last committed offset), so an offset is never reused.
import {
  fdatasyncSync,
  fstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { FakeClock } from "@bayon/core";
import { getSession, getSupervisorState, type EventRow } from "@bayon/db";
import { appendRun, insertEventsBatch } from "@bayon/db/supervisor";
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
  type Segment,
} from "../testing/ingest-harness.js";
import { createIngest, type Ingest } from "./ingest.js";
import type { RawLogFs } from "./raw-log.js";
import { committedEnd } from "./segment.js";

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
const NEWLINE = 0x0a;

/** Where the record holding `offset` ends, its "\n" included. */
function recordEnd(raw: Buffer, offset: number): number {
  const nl = raw.indexOf(NEWLINE, offset);
  return nl === -1 ? raw.length : nl + 1;
}

/**
 * The real fdatasync and insertEventsBatch, watched. A sync records the file's length (what it
 * made durable); an insert checks that each row's record, "\n" included, lies within what this
 * ingest last synced of that raw log. `trace` keeps the order of the two.
 */
function durability() {
  const synced = new Map<number, number>(); // inode → length at its last fdatasync
  const trace: ("sync" | "insert")[] = [];
  const violations: string[] = [];
  const fs: RawLogFs = {
    fdatasync(fd) {
      fdatasyncSync(fd);
      const { ino, size } = fstatSync(fd);
      synced.set(ino, size);
      trace.push("sync");
    },
  };
  const insertEvents: typeof insertEventsBatch = async (db, rows) => {
    for (const sessionId of new Set(rows.map((r) => r.session_id))) {
      const path = rawLogPath(home, sessionId);
      const raw = readFileSync(path);
      const durable = synced.get(statSync(path).ino) ?? 0;
      for (const row of rows) {
        if (row.session_id !== sessionId || row.raw_offset < 0) continue;
        const end = recordEnd(raw, row.raw_offset);
        if (end > durable) {
          violations.push(
            `${sessionId}@${row.raw_offset}: ends at ${end}, synced ${durable}`,
          );
        }
      }
    }
    trace.push("insert");
    return insertEventsBatch(db, rows);
  };
  return { fs, insertEvents, trace, violations, synced };
}

type Spy = ReturnType<typeof durability>;
const watched = (spy: Spy) =>
  createIngest({
    db: t.db,
    clock,
    log,
    fs: spy.fs,
    insertEvents: spy.insertEvents,
  });
const inode = (path: string) => statSync(path).ino;

/** One process segment of `events` texts and a run to its terminal, then a graceful stop. */
async function segment(
  ingest: Ingest,
  sessionId: string,
  events: number,
  resume?: string,
): Promise<Segment> {
  const s = await h.start(
    ingest,
    sessionId,
    { runs: [{ events: texts(events) }] },
    resume === undefined ? {} : { resume },
  );
  expect(await ingest.terminalOf(await h.send(ingest, s))).toBe("ok");
  await h.adapter.stop(s.handle, "graceful");
  await s.attachment.closed;
  return s;
}

/** A segment whose ingest dies (injected) before batch `crashOn` commits: the log holds more. */
async function crashedSegment(
  sessionId: string,
  events: number,
  crashOn: number,
): Promise<Segment> {
  const crashing = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: countingInsert({ crashOn }).insert,
    onFatal: () => undefined,
  });
  const s = await h.start(crashing, sessionId, {
    runs: [{ events: texts(events) }],
  });
  await h.send(crashing, s);
  await expect(s.attachment.closed).rejects.toMatchObject({
    class: "internal",
  });
  await h.adapter.stop(s.handle, "kill");
  return s;
}

/** What must match between two sessions fed the same scripts: offsets may differ, events not. */
const shape = (rows: readonly EventRow[]) =>
  rows.map((r) => [r.kind, r.runner_type, r.text, r.run_id !== null]);

/** Two segments on an intact log: what a session must hold after the same two segments. */
async function reference(first: number, second: number): Promise<EventRow[]> {
  const ingest = createIngest({ db: t.db, clock, log });
  const id = await h.session();
  const one = await segment(ingest, id, first);
  await segment(ingest, id, second, one.handle.runnerSessionId);
  return h.stored(id);
}

test("live: an fdatasync of the raw log precedes every batch commit", async () => {
  const spy = durability();
  const ingest = watched(spy);
  const sessionId = await h.session();
  await segment(ingest, sessionId, 248);

  expect(await h.stored(sessionId)).toHaveLength(250);
  expect(spy.violations).toEqual([]);
  const beforeEachInsert = spy.trace.flatMap((e, i) =>
    e === "insert" ? [spy.trace[i - 1]] : [],
  );
  expect(beforeEachInsert).toEqual(["sync", "sync", "sync"]);
});

test("segment roll: a torn tail is ended and the log fdatasync'd before its start is returned", async () => {
  const spy = durability();
  const ingest = watched(spy);
  const sessionId = await h.session();
  const one = await segment(ingest, sessionId, 10);
  const path = rawLogPath(home, sessionId);
  // A process killed mid-write left half a line.
  writeFileSync(path, '{"kind":"assistant_te', { flag: "a" });
  const torn = statSync(path).size;

  const before = spy.trace.length;
  const { offset } = unwrap(await ingest.beginSegment(sessionId));
  expect(offset).toBe(torn + 1);
  expect(readFileSync(path).at(-1)).toBe(NEWLINE);
  // Durable through the start the lifecycle commits as raw_segment_offset (edge 4).
  expect(spy.trace.slice(before)).toEqual(["sync"]);
  expect(spy.synced.get(inode(path))).toBe(offset);

  // The new segment's own batches are covered too.
  const two = await segment(ingest, sessionId, 10, one.handle.runnerSessionId);
  expect(two.offset).toBe(offset);
  expect(spy.violations).toEqual([]);
});

test("openRun: the raw log is fdatasync'd before the run's binding offset commits", async () => {
  const spy = durability();
  const ingest = watched(spy);
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, { runs: [{ events: texts(5) }] });
  expect(await ingest.terminalOf(await h.send(ingest, s))).toBe("ok");
  const path = rawLogPath(home, sessionId);

  const run = unwrap(await appendRun(t.db, newRunInput(sessionId)));
  const before = spy.trace.length;
  unwrap(await ingest.openRun(sessionId, run.id));
  expect(spy.trace.slice(before)).toEqual(["sync"]);
  const size = statSync(path).size;
  expect(
    unwrap(await getSupervisorState(t.db, `ingest.run.${sessionId}`)),
  ).toEqual({ run_id: run.id, offset: size });
  expect(spy.synced.get(inode(path))).toBe(size);

  unwrap(
    await h.adapter.send(s.handle, {
      runId: run.id,
      text: "go",
      promptPath: "/dev/null",
    }),
  );
  expect(await ingest.terminalOf(run.id)).toBe("ok");
  await h.adapter.stop(s.handle, "graceful");
  await s.attachment.closed;
  expect(spy.violations).toEqual([]);
});

test("replay: the dead process's raw log is fdatasync'd before any replayed row commits", async () => {
  const sessionId = await h.session();
  await crashedSegment(sessionId, 248, 2);
  expect(await h.stored(sessionId)).toHaveLength(100);

  // A fresh supervisor has synced nothing: each replayed row must be covered by its own sync.
  const spy = durability();
  unwrap(await watched(spy).replay(sessionId, h.adapter));
  expect((await h.stored(sessionId)).length).toBeGreaterThan(100);
  expect(spy.trace[0]).toBe("sync");
  expect(spy.trace).toContain("insert");
  expect(spy.violations).toEqual([]);
  const path = rawLogPath(home, sessionId);
  expect(spy.synced.get(inode(path))).toBe(statSync(path).size);
});

test("an fdatasync that fails: its batch never commits, and ingest stops", async () => {
  const counter = countingInsert();
  let failed = false;
  // The first fdatasync after batch 1 commits fails: batch 2's.
  const failing: RawLogFs = {
    fdatasync(fd) {
      if (counter.stats.calls === 1 && !failed) {
        failed = true;
        throw new Error("EIO: injected");
      }
      fdatasyncSync(fd);
    },
  };
  const ingest = createIngest({
    db: t.db,
    clock,
    log,
    fs: failing,
    insertEvents: counter.insert,
    onFatal: () => undefined,
  });
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, {
    runs: [{ events: texts(248) }],
  });
  await h.send(ingest, s);
  await expect(s.attachment.closed).rejects.toMatchObject({
    class: "internal",
  });
  await h.adapter.stop(s.handle, "kill");
  // Batch 2's sync failed, so batch 2 never reached the DB.
  expect(failed).toBe(true);
  expect(counter.stats).toEqual({ calls: 1, rows: 100 });
  expect(await h.stored(sessionId)).toHaveLength(100);
});

test("beginSegment and replay fail, committing nothing, when the raw log cannot be synced", async () => {
  const failing: RawLogFs = {
    fdatasync() {
      throw new Error("EIO: injected");
    },
  };
  const counter = countingInsert();
  const ingest = createIngest({
    db: t.db,
    clock,
    log,
    fs: failing,
    insertEvents: counter.insert,
  });
  const sessionId = await h.session();
  expect(await ingest.beginSegment(sessionId)).toMatchObject({
    ok: false,
    error: { class: "internal", message: expect.stringContaining("EIO") },
  });

  const crashed = await h.session();
  await crashedSegment(crashed, 248, 2);
  expect(await ingest.replay(crashed, h.adapter)).toMatchObject({
    ok: false,
    error: { class: "internal", message: expect.stringContaining("EIO") },
  });
  expect(counter.stats.calls).toBe(0);
  expect(await h.stored(crashed)).toHaveLength(100);
});

const cuts = [
  [
    "cut inside a record",
    (p: string) => truncateSync(p, Math.floor(statSync(p).size / 2)),
  ],
  ["emptied", (p: string) => truncateSync(p, 0)],
  ["deleted", (p: string) => rmSync(p)],
] as const;

test.each(cuts)(
  "a raw log %s below its last committed offset: the next segment starts at that offset; nothing lost or duplicated",
  async (_, cut) => {
    const expected = await reference(40, 30);
    const spy = durability();
    const sessionId = await h.session();
    const one = await segment(watched(spy), sessionId, 40);
    const path = rawLogPath(home, sessionId);
    const committed = unwrap(await committedEnd(t.db, sessionId));
    expect(committed).toBeLessThanOrEqual(statSync(path).size);
    const beforeCut = (await h.stored(sessionId)).length;
    // The disk lost bytes the database still points into (a power cut before an fdatasync that
    // the drive acknowledged, a restored volume, an operator).
    cut(path);

    // A restart: a fresh supervisor adopts the session into a new segment.
    const two = await segment(
      watched(spy),
      sessionId,
      30,
      one.handle.runnerSessionId,
    );
    expect(two.offset).toBe(committed);
    expect(unwrap(await getSession(t.db, sessionId)).raw_segment_offset).toBe(
      committed,
    );
    const rows = await h.stored(sessionId);
    // At a reused offset the unique key would have dropped segment 2's events as duplicates.
    expect(shape(rows)).toEqual(shape(expected));
    const offsets = rows.map((r) => r.raw_offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    const fromTwo = rows.filter((r) => (r.raw_offset ?? -1) >= committed);
    expect(fromTwo).toHaveLength(rows.length - beforeCut);
    expect(spy.violations).toEqual([]);

    // Another restart: replaying the new segment inserts nothing.
    const counter = countingInsert();
    const again = createIngest({
      db: t.db,
      clock,
      log,
      insertEvents: counter.insert,
    });
    unwrap(await again.replay(sessionId, h.adapter));
    expect(counter.stats.rows).toBe(0);
    expect(await h.stored(sessionId)).toHaveLength(rows.length);
  },
  30_000,
);

test("a raw log longer than its last committed offset: replay commits the tail, the next segment starts at the log's end, and a later restart inserts nothing", async () => {
  const expected = await reference(248, 30);
  const sessionId = await h.session();
  // Batch 3, which holds the terminal, dies before it commits: 200 rows stored, 250 logged.
  const one = await crashedSegment(sessionId, 248, 3);
  const path = rawLogPath(home, sessionId);
  const size = statSync(path).size;
  expect(readFileSync(path).at(-1)).toBe(NEWLINE);
  expect(unwrap(await committedEnd(t.db, sessionId))).toBeLessThan(size);

  // A restart: replay, then adoption into a new segment.
  const spy = durability();
  const fresh = watched(spy);
  unwrap(await fresh.replay(sessionId, h.adapter));
  expect(await h.stored(sessionId)).toHaveLength(250);
  const two = await segment(fresh, sessionId, 30, one.handle.runnerSessionId);
  expect(two.offset).toBe(size);
  const rows = await h.stored(sessionId);
  expect(shape(rows)).toEqual(shape(expected));
  const offsets = rows.map((r) => r.raw_offset);
  expect(new Set(offsets).size).toBe(offsets.length);
  expect(spy.violations).toEqual([]);

  // A later restart: replay is a no-op on (session_id, runner_type, raw_offset).
  const counter = countingInsert();
  const again = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: counter.insert,
  });
  unwrap(await again.replay(sessionId, h.adapter));
  unwrap(await again.replay(sessionId, h.adapter));
  expect(counter.stats.rows).toBe(0);
  expect(await h.stored(sessionId)).toHaveLength(rows.length);
}, 30_000);
