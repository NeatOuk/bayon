import { FakeClock } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import {
  DEFAULT_MIN_GAP_MS,
  DEFAULT_RECHECK_MS,
  loadSweepSettings,
} from "./settings.js";

// The sweep's settings (015, NEW-7): read every pass; a missing or malformed removal key turns
// removal off and flagging goes on; the cadence falls back to its defaults.
const clock = new FakeClock(0);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

async function db() {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  return t.db;
}

test("015's rows: removal on, every value read", async () => {
  const s = await loadSweepSettings(await db());
  expect(s).toMatchObject({
    recheckMs: 3_600_000,
    minGapMs: 60_000,
    minEndedMs: 3_600_000,
    removeTimeoutMs: 900_000,
    tmpMinAgeMs: 86_400_000,
    removalOn: true,
    problems: [],
  });
  expect(s.disposable).toContain("node_modules/");
});

test.each([
  ["worktree.min_ended_ms", '"soon"'],
  ["worktree.remove_timeout_ms", "0"],
  ["worktree.disposable_ignored", '"node_modules/"'],
])("a malformed %s turns removal off", async (key, value) => {
  const d = await db();
  unwrap(
    await seedRows(d, {
      settings: [{ key, value_json: value, updated_at: 0 }],
    }),
  );
  const s = await loadSweepSettings(d);
  expect(s.removalOn).toBe(false);
  expect(s.problems).toEqual([`${key} is malformed`]);
});

test("a row that is not JSON: nothing read, removal off, the cadence at its defaults", async () => {
  const d = await db();
  unwrap(
    await seedRows(d, {
      settings: [
        { key: "worktree.recheck_ms", value_json: "{not json", updated_at: 0 },
      ],
    }),
  );
  const s = await loadSweepSettings(d);
  expect(s).toMatchObject({
    recheckMs: DEFAULT_RECHECK_MS,
    minGapMs: DEFAULT_MIN_GAP_MS,
    removalOn: false,
    tmpMinAgeMs: null,
  });
  expect(s.problems[0]).toContain("cannot be read");
});
