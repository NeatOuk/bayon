import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { getRunnerModel, setSessionInFlight } from "./in-flight.js";
import { appendRun } from "./runs.js";
import { createSession, getSession } from "./sessions.js";
import { insertSpend } from "./spend.js";

const T0 = 1_700_000_000_000;
const t = unwrap(await tempDb(new FakeClock(T0)));
unwrap(await seedSpine(t.db, 2));
unwrap(
  await seedRows(t.db, {
    models: [
      {
        id: "m.retired",
        runner_id: SPINE_SEED.runnerId,
        tier: "standard",
        model: "m1",
        active: 0,
      },
      {
        id: "m.cheap",
        runner_id: SPINE_SEED.runnerId,
        tier: "cheap",
        model: "m1",
        context_tokens: 200_000,
        price_in_per_mtok: 3,
      },
    ],
  }),
);
afterAll(() => t.cleanup());

async function spine() {
  const session = unwrap(await createSession(t.db, newSessionInput()));
  const run = unwrap(await appendRun(t.db, newRunInput(session.id)));
  return { sessionId: session.id, runId: run.id };
}

const spend = (s: { sessionId: string; runId: string }, cost_usd: number) => ({
  run_id: s.runId,
  session_id: s.sessionId,
  phase: SPINE_SEED.runClass,
  runner_id: SPINE_SEED.runnerId,
  model: "m1",
  tokens_in: 1,
  tokens_out: 1,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  cost_usd,
  cost_source: "reported" as const,
});

test("getRunnerModel prefers the active row, and is null for an unknown model", async () => {
  const found = unwrap(await getRunnerModel(t.db, SPINE_SEED.runnerId, "m1"));
  expect(found).toMatchObject({ id: "m.cheap", context_tokens: 200_000 });
  expect(
    unwrap(await getRunnerModel(t.db, SPINE_SEED.runnerId, "nope")),
  ).toBeNull();
});

test("cost = settled spend + the open run's estimate, until its spend row settles it", async () => {
  const s = await spine();
  const inFlight = (run_cost_usd: number) =>
    setSessionInFlight(t.db, {
      session_id: s.sessionId,
      run_id: s.runId,
      run_cost_usd,
      context_peak_tokens: null,
    });
  expect(unwrap(await inFlight(0.5)).cost_usd).toBe(0.5);
  expect(unwrap(await inFlight(0.75)).cost_usd).toBe(0.75);
  // The terminal's spend row replaces the estimate: never counted twice.
  unwrap(await insertSpend(t.db, spend(s, 0.25)));
  expect(unwrap(await getSession(t.db, s.sessionId)).cost_usd).toBe(0.25);
  // A late in-flight write for the settled run adds nothing.
  expect(unwrap(await inFlight(9)).cost_usd).toBe(0.25);
  // The next run's estimate adds onto the settled spend.
  const next = unwrap(await appendRun(t.db, newRunInput(s.sessionId)));
  const row = unwrap(
    await setSessionInFlight(t.db, {
      session_id: s.sessionId,
      run_id: next.id,
      run_cost_usd: 1,
      context_peak_tokens: null,
    }),
  );
  expect(row.cost_usd).toBe(1.25);
});

test("context_peak_tokens only grows, and null leaves it alone", async () => {
  const s = await spine();
  const peak = async (context_peak_tokens: number | null) =>
    unwrap(
      await setSessionInFlight(t.db, {
        session_id: s.sessionId,
        run_id: null,
        run_cost_usd: 0,
        context_peak_tokens,
      }),
    ).context_peak_tokens;
  expect(await peak(null)).toBeNull();
  expect(await peak(700)).toBe(700);
  expect(await peak(500)).toBe(700);
  expect(await peak(null)).toBe(700);
  expect(await peak(900)).toBe(900);
});

test("bad input is a validation error, and nothing is written", async () => {
  const s = await spine();
  const bad = await setSessionInFlight(t.db, {
    session_id: s.sessionId,
    run_id: null,
    run_cost_usd: Number.NaN,
    context_peak_tokens: null,
  });
  expect(bad).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(unwrap(await getSession(t.db, s.sessionId)).cost_usd).toBe(0);
});
