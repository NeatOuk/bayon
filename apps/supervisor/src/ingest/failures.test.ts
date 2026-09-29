// Failure paths found in review: a record read after a batch failed, an adapter that cannot
// build a mapper, and terminalOf for a terminal another process committed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { FakeClock, type FrmError } from "@bayon/core";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import type { SessionHandle } from "@bayon/runners";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { rawLogPath } from "../paths.js";
import {
  EOF_CLOSE,
  countingInsert,
  ingestHarness,
  texts,
} from "../testing/ingest-harness.js";
import { createIngest, type IngestAdapter } from "./ingest.js";

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
const records = (sessionId: string) =>
  readFileSync(rawLogPath(home, sessionId), "utf8").split("\n").filter(Boolean)
    .length;

test("a record read after a batch failed still reaches the raw log", async () => {
  const fatal: FrmError[] = [];
  const ingest = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: countingInsert({ crashOn: 1 }).insert,
    onFatal: (e) => fatal.push(e),
  });
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, {
    runs: [{ events: texts(2), gate: "release" }],
  });
  await h.send(ingest, s);
  await vi.waitFor(() => expect(records(sessionId)).toBe(3));
  await clock.advance(50); // the timer's batch fails: ingest is broken
  await vi.waitFor(() => expect(fatal).toHaveLength(1));
  unwrap(await h.adapter.release(s.handle));
  await expect(s.attachment.closed).rejects.toMatchObject({
    class: "internal",
  });
  // The terminal was already read from the stream: it is in the raw log for replay.
  expect(records(sessionId)).toBe(4);
  await h.adapter.stop(s.handle, "kill");
});

test("an adapter that cannot build a mapper is refused, and the session stays attachable", async () => {
  const ingest = createIngest({ db: t.db, clock, log });
  const sessionId = await h.session();
  const { offset } = unwrap(await ingest.beginSegment(sessionId));
  const handle: SessionHandle = {
    sessionId,
    executorRef: "fake:none",
    exited: new Promise<never>(() => undefined),
  };
  const empty: IngestAdapter = {
    records: () =>
      (async function* () {
        yield* [];
      })(),
    createMapper: () => ({ map: () => [] }),
    registration: () => h.adapter.registration(),
  };
  const broken: IngestAdapter = {
    ...empty,
    createMapper: () => {
      throw new Error("no mapper");
    },
  };
  const attach = (adapter: IngestAdapter) =>
    ingest.attach({
      sessionId,
      handle,
      adapter,
      segmentOffset: offset,
      onEof: () => EOF_CLOSE,
    });
  const refused = attach(broken);
  expect(refused.ok ? null : refused.error).toMatchObject({
    class: "internal",
    message: expect.stringContaining("no mapper"),
  });
  const attached = unwrap(attach(empty));
  expect(await attached.closed).toEqual({ endOffset: offset });
});

test("terminalOf finds a terminal that another process committed", async () => {
  const first = createIngest({ db: t.db, clock, log });
  const sessionId = await h.session();
  const s = await h.start(first, sessionId, { runs: [{ events: texts(1) }] });
  const run = await h.send(first, s);
  expect(await first.terminalOf(run)).toBe("ok");
  await h.adapter.stop(s.handle, "graceful");
  await s.attachment.closed;
  const other = createIngest({ db: t.db, clock, log });
  expect(await other.terminalOf(run)).toBe("ok");
});
