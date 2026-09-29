// The reads and the state row supervisor ingest needs for replay and closeRun.
import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import {
  SUPERVISOR_RUNNER_TYPE,
  getFirstTerminal,
  getMaxRawOffset,
  insertEventsBatch,
  type EventInsert,
} from "./events.js";
import { appendRun, finishRun, getRun } from "./runs.js";
import { createSession } from "./sessions.js";
import { getRunSpend, insertSpend } from "./spend.js";
import { getSupervisorState, setSupervisorState } from "./state.js";

test("getRunSpend returns the run's spend row, or null", async () => {
  const s = await spine();
  expect(unwrap(await getRunSpend(t.db, s.runId))).toBeNull();
  const { id } = unwrap(
    await insertSpend(t.db, {
      run_id: s.runId,
      session_id: s.sessionId,
      phase: "build",
      runner_id: "fixture",
      model: "m",
      cost_usd: 0.25,
      cost_source: "reported",
    }),
  );
  expect(unwrap(await getRunSpend(t.db, s.runId))).toMatchObject({
    id,
    run_id: s.runId,
    cost_usd: 0.25,
    tokens_in: 0,
  });
});

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());

async function spine() {
  const session = unwrap(await createSession(t.db, newSessionInput()));
  const run = unwrap(await appendRun(t.db, newRunInput(session.id)));
  return { sessionId: session.id, runId: run.id };
}

const row = (
  s: { sessionId: string; runId: string },
  kind: EventInsert["kind"],
  raw_offset: number,
  runner_type = "fixture.line",
): EventInsert => ({
  session_id: s.sessionId,
  run_id: s.runId,
  ts: T0,
  kind,
  runner_type,
  payload_json: kind === "terminal" ? '{"outcome":"ok"}' : "{}",
  raw_offset,
});

test("getRun returns the row, and a missing run is not_found", async () => {
  const s = await spine();
  expect(unwrap(await getRun(t.db, s.runId))).toMatchObject({
    id: s.runId,
    session_id: s.sessionId,
    seq: 1,
    state: "running",
  });
  unwrap(await finishRun(t.db, s.runId, { state: "timeout" }));
  expect(unwrap(await getRun(t.db, s.runId)).state).toBe("timeout");
  const missing = await getRun(t.db, "no-such-run");
  expect(missing.ok ? null : missing.error.class).toBe("not_found");
});

test("getFirstTerminal is the run's earliest terminal row, or null", async () => {
  const s = await spine();
  expect(unwrap(await getFirstTerminal(t.db, s.runId))).toBeNull();
  unwrap(
    await insertEventsBatch(t.db, [
      row(s, "turn_start", 0),
      row(s, "terminal", 10),
      row(s, "terminal", -1, SUPERVISOR_RUNNER_TYPE),
    ]),
  );
  expect(unwrap(await getFirstTerminal(t.db, s.runId))).toMatchObject({
    run_id: s.runId,
    kind: "terminal",
    raw_offset: 10,
  });
});

test("getMaxRawOffset ignores supervisor rows and other sessions", async () => {
  const s = await spine();
  const other = await spine();
  expect(unwrap(await getMaxRawOffset(t.db, s.sessionId))).toBeNull();
  unwrap(
    await insertEventsBatch(t.db, [
      row(s, "turn_start", 0),
      row(s, "turn_end", 42),
      row(s, "terminal", -1, SUPERVISOR_RUNNER_TYPE),
      row(other, "turn_start", 900),
    ]),
  );
  expect(unwrap(await getMaxRawOffset(t.db, s.sessionId))).toBe(42);
});

test("supervisor state round-trips JSON, overwriting by key", async () => {
  expect(unwrap(await getSupervisorState(t.db, "ingest.run.x"))).toBeNull();
  unwrap(await setSupervisorState(t.db, "ingest.run.x", { run_id: "a", n: 1 }));
  await clock.advance(5);
  unwrap(await setSupervisorState(t.db, "ingest.run.x", { run_id: "b", n: 2 }));
  expect(unwrap(await getSupervisorState(t.db, "ingest.run.x"))).toEqual({
    run_id: "b",
    n: 2,
  });
  const empty = await setSupervisorState(t.db, "", 1);
  expect(empty.ok ? null : empty.error.class).toBe("validation");
});
