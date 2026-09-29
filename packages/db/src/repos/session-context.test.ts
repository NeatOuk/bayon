import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { insertEventsBatch, type EventInsert } from "./events.js";
import { getSessionContext } from "./session-context.js";
import { createSession } from "./sessions.js";

// A session's context totals are the sum of its terminals' `context` (049): the session
// screen's "context saved" line and its failed-open warning.
const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());

const totals = (o: Partial<Record<string, number | string>> = {}) => ({
  ruleset: "ctx1",
  calls: 2,
  blocks: 3,
  compressed: 2,
  failed: 0,
  chars_in: 40_000,
  chars_out: 4_000,
  ...o,
});

const event = (
  sessionId: string,
  offset: number,
  kind: EventInsert["kind"],
  payload: unknown,
): EventInsert => ({
  session_id: sessionId,
  ts: offset,
  kind,
  runner_type: "result",
  payload_json: payload === null ? null : JSON.stringify(payload),
  raw_offset: offset,
});

test("no terminal with totals: null; with some: their sum, the first ruleset, failed included", async () => {
  const s = unwrap(await createSession(t.db, newSessionInput()));
  expect(unwrap(await getSessionContext(t.db, s.id))).toBeNull();
  unwrap(
    await insertEventsBatch(t.db, [
      // A run that was not proxied, an event that is no terminal, a payload with a broken context.
      event(s.id, 1, "terminal", { outcome: "ok" }),
      event(s.id, 2, "assistant_text", { context: totals() }),
      event(s.id, 3, "terminal", { outcome: "ok", context: { calls: "x" } }),
      event(s.id, 4, "terminal", null),
    ]),
  );
  expect(unwrap(await getSessionContext(t.db, s.id))).toBeNull();
  unwrap(
    await insertEventsBatch(t.db, [
      event(s.id, 5, "terminal", { outcome: "ok", context: totals() }),
      event(s.id, 6, "terminal", {
        outcome: "failed",
        context: totals({ ruleset: "ctx2", failed: 1, chars_out: 36_000 }),
      }),
    ]),
  );
  expect(unwrap(await getSessionContext(t.db, s.id))).toEqual({
    ruleset: "ctx1",
    runs: 2,
    calls: 4,
    blocks: 6,
    compressed: 4,
    failed: 1,
    chars_in: 80_000,
    chars_out: 40_000,
  });
  // Another session's terminals are not this one's.
  expect(
    unwrap(await getSessionContext(t.db, SPINE_SEED.sessionId)),
  ).toBeNull();
});
