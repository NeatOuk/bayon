import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  SUPERVISOR_RUNNER_TYPE,
  getRun,
  getRunSpend,
  getSession,
} from "@bayon/db";
import { appendRun, finishRun } from "@bayon/db/supervisor";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { rawLogPath } from "../paths.js";
import {
  EOF_CLOSE,
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
const payloadOf = (json: string | null) =>
  JSON.parse(json ?? "{}") as Record<string, unknown>;

test("a two-run stream: counts, order, run binding, batches, spend", async () => {
  const counter = countingInsert();
  const ingest = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: counter.insert,
  });
  const cursors: number[] = [];
  ingest.onCommit((c) => cursors.push(c.cursor));
  const notices: string[] = [];
  ingest.onTerminal((n) => notices.push(`${n.runId}:${n.outcome}`));
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, {
    runs: [
      {
        events: texts(150),
        spend: {
          tokens_in: 100,
          tokens_out: 20,
          tokens_cache_read: 40,
          tokens_cache_write: 10,
          cost_usd: 0.001,
        },
      },
      {
        events: texts(30, "u"),
        spend: {
          tokens_in: 50,
          tokens_out: 10,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost_usd: 0.0005,
        },
      },
    ],
  });
  const run1 = await h.send(ingest, s);
  expect(await ingest.terminalOf(run1)).toBe("ok");
  const run2 = await h.send(ingest, s);
  expect(await ingest.terminalOf(run2)).toBe("ok");
  await h.adapter.stop(s.handle, "graceful");
  const { endOffset } = await s.attachment.closed;

  const rows = await h.stored(sessionId);
  // session_init + 150 + terminal, then 30 + terminal.
  expect(rows).toHaveLength(183);
  expect(rows.filter((r) => r.kind === "terminal")).toHaveLength(2);
  expect(rows.slice(0, 152).every((r) => r.run_id === run1)).toBe(true);
  expect(rows.slice(152).every((r) => r.run_id === run2)).toBe(true);

  // The raw log came first: each event sits at the start of its record.
  const raw = readFileSync(rawLogPath(home, sessionId));
  expect(endOffset).toBe(raw.length);
  const offsets = rows.map((r) => r.raw_offset ?? -1);
  expect(offsets).toEqual(offsets.toSorted((a, b) => a - b));
  for (const offset of offsets) {
    expect(offset === 0 || raw[offset - 1] === 0x0a).toBe(true);
    expect(raw.subarray(offset, offset + 8).toString()).toBe('{"kind":');
  }

  // 100 rows, then the terminal's flush, then run 2's: never one per event.
  expect(counter.stats).toEqual({ calls: 3, rows: 183 });
  expect(cursors).toHaveLength(3);
  expect(cursors.at(-1)).toBe(rows.at(-1)?.id);

  // Spend: per-run deltas of the runner's running totals.
  expect(unwrap(await getRunSpend(t.db, run1))).toMatchObject({
    session_id: sessionId,
    phase: "fixture_only",
    runner_id: "fixture",
    model: "fixture-model",
    tokens_in: 100,
    tokens_out: 20,
    tokens_cache_read: 40,
    tokens_cache_write: 10,
    cost_usd: 0.001,
    cost_source: "reported",
    cache_hit_ratio: 40 / 150,
  });
  expect(unwrap(await getRunSpend(t.db, run2))).toMatchObject({
    tokens_in: 50,
    tokens_out: 10,
    cost_usd: 0.0005,
  });
  const session = unwrap(await getSession(t.db, sessionId));
  expect(session).toMatchObject({
    tokens_in: 150,
    tokens_out: 30,
    last_event_at: T0,
  });
  expect(session.cost_usd).toBeCloseTo(0.0015, 12);
  expect(unwrap(await getRun(t.db, run1)).state).toBe("ok");
  expect(notices).toEqual([`${run1}:ok`, `${run2}:ok`]);
});

test("tool results and reasoning are capped end to end (§8.5, §4)", async () => {
  const ingest = createIngest({ db: t.db, clock, log });
  const sessionId = await h.session();
  const output = Array.from({ length: 300 }, (_, i) => `out ${i}`).join("\n");
  const thought = "hmm ".repeat(2_500);
  const s = await h.start(ingest, sessionId, {
    runs: [
      {
        events: [
          {
            kind: "tool_result",
            runner_type: "fixture.tool",
            tool_name: "bash",
            status: "ok",
            text: output,
            payload: { call_id: "call-big" },
          },
          {
            kind: "reasoning",
            runner_type: "fixture.think",
            text: thought,
            payload: {},
          },
        ],
      },
    ],
  });
  await ingest.terminalOf(await h.send(ingest, s));
  await h.adapter.stop(s.handle, "graceful");
  await s.attachment.closed;
  const rows = await h.stored(sessionId);
  const toolDir = join(dirname(rawLogPath(home, sessionId)), "tool");
  const result = rows.find((r) => r.kind === "tool_result");
  expect(result).toMatchObject({
    truncated: 1,
    bytes_original: Buffer.byteLength(output),
    payload_path: join(toolDir, "call-big.txt"),
  });
  expect(readFileSync(join(toolDir, "call-big.txt"), "utf8")).toBe(output);
  const reasoning = rows.find((r) => r.kind === "reasoning");
  expect(Buffer.byteLength(reasoning?.text ?? "")).toBe(4_096);
  expect(readFileSync(reasoning?.payload_path ?? "", "utf8")).toBe(thought);
});

test("the first terminal of a run wins; a later one is stored as runner_native", async () => {
  const ingest = createIngest({ db: t.db, clock, log });
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, {
    runs: [
      {
        events: [
          ...texts(2),
          {
            kind: "terminal",
            runner_type: "fixture.early",
            payload: { outcome: "failed" },
          },
        ],
      },
    ],
  });
  const run = await h.send(ingest, s);
  expect(await ingest.terminalOf(run)).toBe("failed");
  await h.adapter.stop(s.handle, "graceful");
  await s.attachment.closed;
  const rows = await h.stored(sessionId);
  expect(rows.map((r) => r.kind)).toEqual([
    "session_init",
    "assistant_text",
    "assistant_text",
    "terminal",
    "runner_native",
  ]);
  expect(rows[3]?.runner_type).toBe("fixture.early");
  expect(rows[4]).toMatchObject({
    runner_type: "fixture.terminal",
    run_id: null,
  });
  expect(payloadOf(rows[4]?.payload_json ?? null)).toMatchObject({
    demoted_kind: "terminal",
  });
  expect(unwrap(await getRun(t.db, run)).state).toBe("failed");
  expect(unwrap(await getRunSpend(t.db, run))).toMatchObject({
    cost_usd: 0,
    tokens_in: 0,
    cost_source: "estimated",
  });
});

test("a stream that ends mid-run gets the supervisor's terminal at -runs.seq", async () => {
  const ingest = createIngest({ db: t.db, clock, log });
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, {
    runs: [{ events: texts(3), then: "exit0" }],
  });
  const run = await h.send(ingest, s);
  await s.attachment.closed;
  expect(unwrap(await getRun(t.db, run))).toMatchObject({
    state: "failed",
    error_class: "runner_exited_without_terminal",
  });
  expect(await ingest.terminalOf(run)).toBe("failed");
  const last = (await h.stored(sessionId)).at(-1);
  expect(last).toMatchObject({
    kind: "terminal",
    runner_type: SUPERVISOR_RUNNER_TYPE,
    raw_offset: -1,
    run_id: run,
  });
  expect(payloadOf(last?.payload_json ?? null)).toMatchObject({
    outcome: "failed",
    error: {
      class: "runner_exited_without_terminal",
      message: EOF_CLOSE.message,
    },
  });
  expect(unwrap(await getRunSpend(t.db, run))).toMatchObject({ cost_usd: 0 });
});

test("closeRun keeps a final runs.state, runs once, and demotes a late runner terminal", async () => {
  const ingest = createIngest({ db: t.db, clock, log });
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, {
    runs: [{ events: texts(1), then: "hang" }],
  });
  const run = await h.send(ingest, s);
  // The run timer's verdict comes first.
  unwrap(await finishRun(t.db, run, { state: "timeout" }));
  const close = {
    outcome: "interrupted",
    errorClass: "timeout",
    message: "wall clock",
  } as const;
  unwrap(await ingest.closeRun(sessionId, run, close));
  unwrap(await ingest.closeRun(sessionId, run, close));
  expect(await ingest.terminalOf(run)).toBe("timeout");
  unwrap(await h.adapter.interrupt(s.handle));
  await h.adapter.stop(s.handle, "graceful");
  await s.attachment.closed;
  const rows = await h.stored(sessionId);
  const terminals = rows.filter((r) => r.kind === "terminal");
  expect(terminals).toHaveLength(1);
  expect(terminals[0]).toMatchObject({
    runner_type: SUPERVISOR_RUNNER_TYPE,
    raw_offset: -1,
  });
  expect(payloadOf(terminals[0]?.payload_json ?? null)).toMatchObject({
    outcome: "timeout",
  });
  expect(rows.filter((r) => r.kind === "runner_native")).toHaveLength(1);
  expect(unwrap(await getRun(t.db, run)).state).toBe("timeout");
});

const records = (sessionId: string) =>
  readFileSync(rawLogPath(home, sessionId), "utf8").split("\n").filter(Boolean)
    .length;

test("a quiet stream commits on the 50 ms timer", async () => {
  const counter = countingInsert();
  const ingest = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: counter.insert,
  });
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, {
    runs: [{ events: texts(2), gate: "release" }],
  });
  await h.send(ingest, s);
  await vi.waitFor(() => expect(records(sessionId)).toBe(3));
  expect(counter.stats.calls).toBe(0);
  await clock.advance(49);
  expect(counter.stats.calls).toBe(0);
  await clock.advance(1);
  await vi.waitFor(() => expect(counter.stats).toEqual({ calls: 1, rows: 3 }));
  unwrap(await h.adapter.release(s.handle));
  await h.adapter.stop(s.handle, "graceful");
  await s.attachment.closed;
  expect(counter.stats).toEqual({ calls: 2, rows: 4 });
});

test("shutdown commits what is pending and leaves the child running", async () => {
  const counter = countingInsert();
  const ingest = createIngest({
    db: t.db,
    clock,
    log,
    insertEvents: counter.insert,
  });
  const sessionId = await h.session();
  const s = await h.start(ingest, sessionId, {
    runs: [{ events: texts(2), gate: "release" }],
  });
  await h.send(ingest, s);
  await vi.waitFor(() => expect(records(sessionId)).toBe(3));
  expect(counter.stats.calls).toBe(0);
  await ingest.shutdown();
  expect(counter.stats).toEqual({ calls: 1, rows: 3 });
  const alive = await Promise.race([
    s.handle.exited.then(() => false),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(true))),
  ]);
  expect(alive).toBe(true);
  await h.adapter.stop(s.handle, "kill");
  await s.attachment.closed;
});

test("segments: a torn line is closed off, a moved offset and a second open run are refused", async () => {
  const ingest = createIngest({ db: t.db, clock, log });
  const sessionId = await h.session();
  const raw = rawLogPath(home, sessionId);
  mkdirSync(dirname(raw), { recursive: true });
  writeFileSync(raw, '{"kind":"turn_start"');
  const early = await ingest.openRun(sessionId, "no-run");
  expect(early.ok ? null : early.error.class).toBe("validation");

  const { offset } = unwrap(await ingest.beginSegment(sessionId));
  expect(offset).toBe(21);
  expect(readFileSync(raw, "utf8")).toBe('{"kind":"turn_start"\n');
  const s = await h.start(ingest, sessionId, {
    runs: [{ events: [], then: "hang" }],
  });
  expect(s.offset).toBe(21);
  const again = ingest.attach({
    sessionId,
    handle: s.handle,
    adapter: h.adapter,
    segmentOffset: s.offset,
    onEof: () => EOF_CLOSE,
  });
  expect(again.ok ? null : again.error.class).toBe("conflict");

  const run1 = unwrap(await appendRun(t.db, newRunInput(sessionId)));
  const run2 = unwrap(await appendRun(t.db, newRunInput(sessionId)));
  unwrap(await ingest.openRun(sessionId, run1.id));
  const second = await ingest.openRun(sessionId, run2.id);
  expect(second.ok ? null : second.error.class).toBe("conflict");
  await h.adapter.stop(s.handle, "kill");
  await s.attachment.closed;
  expect(unwrap(await getRun(t.db, run1.id)).state).toBe("failed");
});
