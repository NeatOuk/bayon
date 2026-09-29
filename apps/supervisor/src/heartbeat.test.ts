import { FakeClock } from "@bayon/core";
import { readHeartbeat } from "@bayon/db";
import { tempDb, unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { startHeartbeat } from "./heartbeat.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());

test("beats at start and every interval on the injected clock, until stopped", async () => {
  const beat = unwrap(
    await startHeartbeat({
      db: t.db,
      clock,
      log: pino({ level: "silent" }),
      intervalMs: 5_000,
      pid: 4242,
      version: "0.1.0",
      startedAt: T0,
    }),
  );
  expect(unwrap(await readHeartbeat(t.db))?.at).toBe(T0);
  await clock.advance(4_999);
  expect(unwrap(await readHeartbeat(t.db))?.at).toBe(T0);
  await clock.advance(1);
  await vi.waitFor(async () =>
    expect(unwrap(await readHeartbeat(t.db))).toEqual({
      pid: 4242,
      version: "0.1.0",
      startedAt: T0,
      at: T0 + 5_000,
    }),
  );
  await beat.stop();
  await clock.advance(10_000);
  expect(unwrap(await readHeartbeat(t.db))?.at).toBe(T0 + 5_000);
});
