import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { appendRun } from "./runs.js";
import { createSession, getSession } from "./sessions.js";
import { insertSpend, type NewSpend } from "./spend.js";

const T0 = 1_700_000_000_000;
const t = unwrap(await tempDb(new FakeClock(T0)));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());

async function spine() {
  const session = unwrap(await createSession(t.db, newSessionInput()));
  const run = unwrap(await appendRun(t.db, newRunInput(session.id)));
  return { sessionId: session.id, runId: run.id };
}

const spend = (s: { sessionId: string; runId: string }): NewSpend => ({
  run_id: s.runId,
  session_id: s.sessionId,
  phase: SPINE_SEED.runClass,
  runner_id: SPINE_SEED.runnerId,
  model: "fixture-model",
  tokens_in: 1_000,
  tokens_out: 200,
  tokens_cache_read: 50,
  tokens_cache_write: 5,
  cost_usd: 0.125,
  cost_source: "reported",
});

test("insertSpend writes the run's row and adds its deltas to the session", async () => {
  const s = await spine();
  const result = unwrap(await insertSpend(t.db, spend(s)));
  expect(result.created).toBe(true);
  expect(unwrap(await getSession(t.db, s.sessionId))).toMatchObject({
    cost_usd: 0.125,
    tokens_in: 1_000,
    tokens_out: 200,
    tokens_cache_read: 50,
    tokens_cache_write: 5,
  });
});

test("a run gets at most one spend row, and a repeat adds nothing", async () => {
  const s = await spine();
  const first = unwrap(await insertSpend(t.db, spend(s)));
  const before = unwrap(await getSession(t.db, s.sessionId));
  const again = unwrap(await insertSpend(t.db, { ...spend(s), cost_usd: 9 }));
  expect(again).toEqual({ id: first.id, created: false });
  expect(unwrap(await getSession(t.db, s.sessionId))).toEqual(before);
});

test("a run from another session, or an unknown run, is a validation error", async () => {
  const a = await spine();
  const b = await spine();
  expect(
    await insertSpend(t.db, { ...spend(a), session_id: b.sessionId }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(
    await insertSpend(t.db, { ...spend(a), run_id: "no-such-run" }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("tokens_saved (049): a proxied run's saving is added to the session; an unproxied run leaves it", async () => {
  const s = await spine();
  // An unproxied run first: the session has no saving to show, not "saved 0".
  unwrap(await insertSpend(t.db, spend(s)));
  expect(unwrap(await getSession(t.db, s.sessionId)).tokens_saved).toBeNull();
  const run2 = unwrap(await appendRun(t.db, newRunInput(s.sessionId)));
  const second = { sessionId: s.sessionId, runId: run2.id };
  unwrap(
    await insertSpend(t.db, {
      ...spend(second),
      tokens_tool_result: 6_000,
      tokens_saved: 4_500,
    }),
  );
  expect(unwrap(await getSession(t.db, s.sessionId))).toMatchObject({
    tokens_saved: 4_500,
    tokens_in: 2_000,
  });
  const run3 = unwrap(await appendRun(t.db, newRunInput(s.sessionId)));
  unwrap(
    await insertSpend(t.db, {
      ...spend({ sessionId: s.sessionId, runId: run3.id }),
      tokens_saved: 500,
    }),
  );
  const run4 = unwrap(await appendRun(t.db, newRunInput(s.sessionId)));
  unwrap(
    await insertSpend(t.db, {
      ...spend({ sessionId: s.sessionId, runId: run4.id }),
      tokens_saved: null,
    }),
  );
  expect(unwrap(await getSession(t.db, s.sessionId)).tokens_saved).toBe(5_000);
});
