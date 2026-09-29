import { FakeClock, type ExitReason } from "@bayon/core";
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
import { createSession, updateSessionState } from "./sessions.js";
import { getRunSpend, insertSpend } from "./spend.js";

// §8.9: an abandoned session's spend is wasted, whether its rows came before the session ended
// or after (a replay after a crash).

const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());

async function session(): Promise<string> {
  return unwrap(await createSession(t.db, newSessionInput())).id;
}

async function spendOn(sessionId: string, wasted?: 0 | 1): Promise<string> {
  const run = unwrap(await appendRun(t.db, newRunInput(sessionId)));
  unwrap(
    await insertSpend(t.db, {
      run_id: run.id,
      session_id: sessionId,
      phase: SPINE_SEED.runClass,
      runner_id: SPINE_SEED.runnerId,
      model: "fixture-model",
      cost_usd: 0.5,
      cost_source: "reported",
      ...(wasted === undefined ? {} : { wasted }),
    }),
  );
  return run.id;
}

const end = async (sessionId: string, exit_reason: ExitReason) =>
  unwrap(
    await updateSessionState(t.db, sessionId, {
      from: ["pending"],
      to: "exited",
      patch: { exit_reason },
    }),
  );

const wastedOf = async (runId: string) =>
  unwrap(await getRunSpend(t.db, runId))?.wasted;

test("ending a session abandoned flags its spend rows wasted, and no other session's", async () => {
  const abandoned = await session();
  const other = await session();
  const runs = [await spendOn(abandoned), await spendOn(abandoned)];
  const bystander = await spendOn(other);

  await end(abandoned, "abandoned");

  expect(await Promise.all(runs.map(wastedOf))).toEqual([1, 1]);
  expect(await wastedOf(bystander)).toBe(0);
});

test("a spend row written after the session ended abandoned is wasted", async () => {
  const s = await session();
  await end(s, "abandoned");
  expect(await wastedOf(await spendOn(s))).toBe(1);
});

test.each(["ok", "error", "killed", "timeout"] as const)(
  "ending a session %s leaves its spend as it was",
  async (reason) => {
    const s = await session();
    const clean = await spendOn(s);
    const failed = await spendOn(s, 1);
    await end(s, reason);
    expect(await wastedOf(clean)).toBe(0);
    expect(await wastedOf(failed)).toBe(1);
  },
);
