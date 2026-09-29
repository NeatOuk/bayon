import Database from "better-sqlite3";
import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { heartbeat } from "./repos/fleet.js";
import { createSession } from "./repos/sessions.js";
import {
  newSessionInput,
  seedSpine,
  setBusyTimeoutForTest,
  tempDb,
  unwrap,
} from "./testing.js";

// tempDb makes the jitter factor exactly 1, so the retries wait 25, 50 and 100 ms.
const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
// Without this the BUSY would wait out busy_timeout (5 s of real time) inside SQLite.
unwrap(await setBusyTimeoutForTest(t.db, 0));
const otherWriter = new Database(t.path);
afterAll(() => {
  otherWriter.close();
  t.cleanup();
});

const beat = () => heartbeat(t.db, { pid: 1, version: "test", startedAt: T0 });

test("a writer that hits SQLITE_BUSY waits on the clock, then recovers on retry 1", async () => {
  otherWriter.exec("BEGIN IMMEDIATE");
  const before = t.db.stats;
  let settled = false;
  const pending = beat().finally(() => {
    settled = true;
  });
  await clock.advance(24);
  expect(settled).toBe(false); // still waiting for the first retry, due at 25 ms
  otherWriter.exec("COMMIT");
  await clock.advance(1);
  expect(await pending).toEqual({ ok: true, value: undefined });
  expect(t.db.stats).toEqual({ txns: before.txns + 1, busy: before.busy + 1 });
});

test("a lock that is never released gives db_busy after three retries", async () => {
  otherWriter.exec("BEGIN IMMEDIATE");
  const before = t.db.stats;
  const pending = beat();
  await clock.advance(25 + 50 + 100);
  const result = await pending;
  otherWriter.exec("ROLLBACK");
  expect(result).toMatchObject({
    ok: false,
    error: { class: "db_busy", retryable: true },
  });
  expect(t.db.stats).toEqual({ txns: before.txns, busy: before.busy + 3 });
});

test("other errors are returned at once, never retried", async () => {
  const before = t.db.stats;
  const result = await createSession(t.db, {
    ...newSessionInput(),
    agent_id: "no-such-agent",
  });
  expect(result).toMatchObject({
    ok: false,
    error: { class: "validation", retryable: false },
  });
  expect(t.db.stats).toEqual(before);
});
