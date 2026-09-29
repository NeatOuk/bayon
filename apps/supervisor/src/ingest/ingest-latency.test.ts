// Ingest latency with and without the raw log's fdatasync ("the per-batch fdatasync
// costs ingest latency: measure p99"). A bench, opt-in, asserting nothing:
//   FRM_BENCH=1 pnpm exec vitest run apps/supervisor/src/ingest/ingest-latency.test.ts
// A batch commit is timed from its first fdatasync (where commit() starts) to the end of its
// insertEventsBatch; an event from its mapping (its ts) to that end. Timers are inert, as in the
// other ingest tests, so a batch closes at 100 rows or on a flush, never on the 50 ms timer.
import { fdatasyncSync, mkdtempSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { FakeClock, type Clock } from "@bayon/core";
import { insertEventsBatch } from "@bayon/db/supervisor";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { pino } from "pino";
import { describe, test } from "vitest";
import { ingestHarness, texts } from "../testing/ingest-harness.js";
import { createIngest } from "./ingest.js";
import type { RawLogFs } from "./raw-log.js";

type Mode = "fdatasync" | "none";
const MODES: readonly Mode[] = ["fdatasync", "none"];
/** [concurrent sessions, events each, rounds]; each session adds a start and a terminal. */
const SHAPES = [
  [1, 4_998, 10],
  [8, 1_998, 3],
] as const;

/** Real time for event ts, inert timers: the batcher closes a batch at 100 rows or on a flush. */
const realTime: Clock = {
  now: () => Date.now(),
  after: (_ms, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    }),
};

function probe(mode: Mode) {
  const commits: number[] = [];
  const syncs: number[] = [];
  const events: number[] = [];
  let commitStart: number | undefined;
  const fs: RawLogFs = {
    fdatasync(fd) {
      const t0 = performance.now();
      commitStart ??= t0;
      if (mode === "fdatasync") fdatasyncSync(fd);
      syncs.push(performance.now() - t0);
    },
  };
  const insertEvents: typeof insertEventsBatch = async (db, rows) => {
    const t0 = commitStart ?? performance.now();
    const result = await insertEventsBatch(db, rows);
    commitStart = undefined;
    commits.push(performance.now() - t0);
    const end = Date.now();
    for (const row of rows) events.push(end - row.ts);
    return result;
  };
  /** Forgets beginSegment's fdatasync, which is no batch's. */
  const segmentStarted = () => {
    commitStart = undefined;
  };
  return { fs, insertEvents, commits, syncs, events, segmentStarted };
}

function stats(xs: readonly number[]): string {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
  const f = (x: number) => x.toFixed(2);
  return `n=${sorted.length} p50=${f(at(0.5))} p99=${f(at(0.99))} max=${f(at(1))}`;
}

async function bench(
  concurrency: number,
  events: number,
  rounds: number,
): Promise<void> {
  const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  const home = mkdtempSync("/tmp/frm-bench-");
  try {
    unwrap(await seedSpine(t.db, 2));
    const log = pino({ level: "silent" });
    const h = ingestHarness({
      db: t.db,
      home,
      sessionInput: newSessionInput,
      runInput: newRunInput,
    });
    const probes = new Map(MODES.map((m) => [m, probe(m)] as const));
    for (let round = 0; round < rounds; round += 1) {
      // Alternate which mode goes first, so drift in the disk or the DB hits both.
      const order = round % 2 === 0 ? MODES : [...MODES].reverse();
      for (const mode of order) {
        const p = probes.get(mode) ?? probe(mode);
        const ingest = createIngest({
          db: t.db,
          clock: realTime,
          log,
          fs: p.fs,
          insertEvents: p.insertEvents,
        });
        const segments = await Promise.all(
          Array.from({ length: concurrency }, async () => {
            const id = await h.session();
            return h.start(ingest, id, { runs: [{ events: texts(events) }] });
          }),
        );
        p.segmentStarted();
        await Promise.all(
          segments.map(async (s) => {
            await ingest.terminalOf(await h.send(ingest, s));
            await h.adapter.stop(s.handle, "graceful");
            await s.attachment.closed;
          }),
        );
      }
    }
    for (const [mode, p] of probes) {
      console.info(
        `[evidence] ${concurrency} session(s), fdatasync=${mode}: ` +
          `batch commit ms ${stats(p.commits)} | event ms ${stats(p.events)} | ` +
          `each fdatasync ms ${stats(p.syncs)}`,
      );
    }
  } finally {
    t.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

describe.runIf(process.env.FRM_BENCH === "1")("ingest latency", () => {
  test.each(SHAPES)(
    "%i session(s) × %i events, %i rounds",
    (concurrency, events, rounds) => bench(concurrency, events, rounds),
    600_000,
  );
});
