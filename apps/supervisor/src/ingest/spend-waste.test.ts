import { mkdtempSync, rmSync } from "node:fs";
import { FakeClock, err, ok, type RunState } from "@bayon/core";
import { getRunSpend, getSession } from "@bayon/db";
import { finishRun } from "@bayon/db/supervisor";
import {
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, describe, expect, test } from "vitest";
import { ingestHarness, texts } from "../testing/ingest-harness.js";
import { createIngest } from "./ingest.js";
import { spendRow } from "./spend.js";

// §8.9 at the supervisor: a failed or timed-out run's spend row is wasted, and a pulse's run
// carries its pulse id.

const clock = new FakeClock(1_700_000_000_000);
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

const session = unwrap(await getSession(t.db, SPINE_SEED.sessionId));

describe("spendRow", () => {
  const row = (runState: RunState, pulseId: string | null = null) =>
    spendRow({
      runId: "run-1",
      session,
      terminalPayload: {},
      runState,
      pulseId,
    });

  test.each([
    ["failed", 1],
    ["timeout", 1],
    ["ok", 0],
    ["interrupted", 0],
    ["budget_stop", 0],
  ] as const)("a run that ended %s has wasted = %i", (state, wasted) => {
    expect(row(state).wasted).toBe(wasted);
  });

  test("the pulse id is the caller's, null by default", () => {
    expect(row("ok").pulse_id).toBeNull();
    expect(row("ok", "pulse-7").pulse_id).toBe("pulse-7");
  });

  // a proxied run's terminal carries its context totals; chars/4, rounded.
  const withContext = (context: unknown) =>
    spendRow({
      runId: "run-1",
      session,
      terminalPayload: { outcome: "ok", context },
      runState: "ok",
      pulseId: null,
    });
  const totals = {
    ruleset: "ctx1",
    calls: 3,
    blocks: 4,
    compressed: 2,
    failed: 1,
    chars_in: 40_002,
    chars_out: 6_001,
  };

  test("a proxied run: its large tool output and the saving, as estimated tokens", () => {
    expect(withContext(totals)).toMatchObject({
      tokens_tool_result: 10_001,
      tokens_saved: 8_500,
    });
  });

  test("an unproxied run, or totals that do not parse: both null", () => {
    expect(row("ok")).toMatchObject({
      tokens_tool_result: null,
      tokens_saved: null,
    });
    expect(withContext({ ...totals, chars_in: -1 })).toMatchObject({
      tokens_tool_result: null,
      tokens_saved: null,
    });
  });

  test("a saving never goes negative", () => {
    expect(
      withContext({ ...totals, chars_in: 100, chars_out: 400 }),
    ).toMatchObject({ tokens_tool_result: 25, tokens_saved: 0 });
  });
});

describe("ingest writes the flags", () => {
  test("a runner terminal that failed: wasted", async () => {
    const ingest = createIngest({ db: t.db, clock, log });
    const s = await h.start(ingest, await h.session(), {
      runs: [
        { events: texts(1), terminal: { outcome: "failed" } },
        { events: texts(1) },
      ],
    });
    const failed = await h.send(ingest, s);
    expect(await ingest.terminalOf(failed)).toBe("failed");
    const fine = await h.send(ingest, s);
    expect(await ingest.terminalOf(fine)).toBe("ok");
    await h.adapter.stop(s.handle, "graceful");
    await s.attachment.closed;
    expect(unwrap(await getRunSpend(t.db, failed))).toMatchObject({
      wasted: 1,
      pulse_id: null,
    });
    expect(unwrap(await getRunSpend(t.db, fine))?.wasted).toBe(0);
  });

  test("the run timer's timeout stands over the supervisor's close: wasted", async () => {
    const ingest = createIngest({ db: t.db, clock, log });
    const sessionId = await h.session();
    const s = await h.start(ingest, sessionId, {
      runs: [{ events: texts(1), then: "hang" }],
    });
    const run = await h.send(ingest, s);
    unwrap(await finishRun(t.db, run, { state: "timeout" }));
    unwrap(
      await ingest.closeRun(sessionId, run, {
        outcome: "interrupted",
        errorClass: "timeout",
        message: "wall clock",
      }),
    );
    expect(await ingest.terminalOf(run)).toBe("timeout");
    unwrap(await h.adapter.interrupt(s.handle));
    await h.adapter.stop(s.handle, "graceful");
    await s.attachment.closed;
    expect(unwrap(await getRunSpend(t.db, run))?.wasted).toBe(1);
  });

  test("an interrupted run is not wasted", async () => {
    const ingest = createIngest({ db: t.db, clock, log });
    const sessionId = await h.session();
    const s = await h.start(ingest, sessionId, {
      runs: [{ events: texts(1), then: "hang" }],
    });
    const run = await h.send(ingest, s);
    unwrap(
      await ingest.closeRun(sessionId, run, {
        outcome: "interrupted",
        errorClass: "interrupted",
        message: "operator",
      }),
    );
    expect(await ingest.terminalOf(run)).toBe("interrupted");
    unwrap(await h.adapter.interrupt(s.handle));
    await h.adapter.stop(s.handle, "graceful");
    await s.attachment.closed;
    expect(unwrap(await getRunSpend(t.db, run))?.wasted).toBe(0);
  });

  test("a proxied run's saving reaches its spend row and its session", async () => {
    const ingest = createIngest({ db: t.db, clock, log });
    const sessionId = await h.session();
    const context = {
      ruleset: "ctx1",
      calls: 2,
      blocks: 2,
      compressed: 2,
      failed: 0,
      chars_in: 80_000,
      chars_out: 8_000,
    };
    const s = await h.start(ingest, sessionId, {
      runs: [
        { events: texts(1), terminal: { context } },
        { events: texts(1) },
        { events: texts(1), terminal: { context } },
      ],
    });
    const first = await h.send(ingest, s);
    expect(await ingest.terminalOf(first)).toBe("ok");
    const plain = await h.send(ingest, s);
    expect(await ingest.terminalOf(plain)).toBe("ok");
    const last = await h.send(ingest, s);
    expect(await ingest.terminalOf(last)).toBe("ok");
    await h.adapter.stop(s.handle, "graceful");
    await s.attachment.closed;
    expect(unwrap(await getRunSpend(t.db, first))).toMatchObject({
      tokens_tool_result: 20_000,
      tokens_saved: 18_000,
    });
    expect(unwrap(await getRunSpend(t.db, plain))).toMatchObject({
      tokens_tool_result: null,
      tokens_saved: null,
    });
    expect(unwrap(await getSession(t.db, sessionId)).tokens_saved).toBe(36_000);
  });

  test("pulseOf names the run's pulse on its spend row", async () => {
    const asked: string[] = [];
    const ingest = createIngest({
      db: t.db,
      clock,
      log,
      pulseOf: async ({ sessionId, runId }) => {
        asked.push(`${sessionId}/${runId}`);
        return ok(`pulse-of-${runId}`);
      },
    });
    const sessionId = await h.session();
    const s = await h.start(ingest, sessionId, {
      runs: [{ events: texts(1) }],
    });
    const run = await h.send(ingest, s);
    expect(await ingest.terminalOf(run)).toBe("ok");
    await h.adapter.stop(s.handle, "graceful");
    await s.attachment.closed;
    expect(asked).toEqual([`${sessionId}/${run}`]);
    expect(unwrap(await getRunSpend(t.db, run))).toMatchObject({
      pulse_id: `pulse-of-${run}`,
      wasted: 0,
    });
  });

  test("a pulseOf failure fails the settle: no spend row without its pulse", async () => {
    const ingest = createIngest({
      db: t.db,
      clock,
      log,
      pulseOf: async () =>
        err({
          class: "internal",
          message: "no pulses table",
          retryable: false,
        }),
    });
    const sessionId = await h.session();
    const s = await h.start(ingest, sessionId, {
      runs: [{ events: texts(1) }],
    });
    const run = await h.send(ingest, s);
    await expect(s.attachment.closed).rejects.toMatchObject({
      class: "internal",
    });
    expect(unwrap(await getRunSpend(t.db, run))).toBeNull();
    await h.adapter.stop(s.handle, "kill");
  });
});
