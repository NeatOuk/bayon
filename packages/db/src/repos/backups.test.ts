import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { tempDb, unwrap } from "../testing.js";
import {
  getLastBackup,
  hasOkBackup,
  recordBackup,
  type NewBackup,
} from "./backups.js";

// backups: the supervisor records each finished attempt; the newest one is the last.
const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());

const validation = { ok: false, error: { class: "validation" } };

test("getLastBackup is null before the first attempt, then the newest by ended_at", async () => {
  expect(unwrap(await getLastBackup(t.db))).toBeNull();
  const ok = unwrap(
    await recordBackup(t.db, {
      started_at: 100,
      ended_at: 200,
      outcome: "ok",
      path: "/backups/a.db.enc",
    }),
  );
  expect(ok).toMatchObject({
    outcome: "ok",
    path: "/backups/a.db.enc",
    error: null,
  });
  expect(unwrap(await getLastBackup(t.db))).toEqual(ok);
  const failed = unwrap(
    await recordBackup(t.db, {
      started_at: 300,
      ended_at: 400,
      outcome: "failed",
      error: "disk full",
    }),
  );
  expect(failed).toMatchObject({ path: null, error: "disk full" });
  // Recorded later but ended earlier: the newest is still the one that ended last.
  unwrap(
    await recordBackup(t.db, {
      started_at: 150,
      ended_at: 250,
      outcome: "ok",
      path: "/backups/b.db.enc",
    }),
  );
  expect(unwrap(await getLastBackup(t.db))).toEqual(failed);
});

test.each<readonly [string, NewBackup]>([
  [
    "an ok attempt without its file",
    { started_at: 1, ended_at: 2, outcome: "ok" },
  ],
  [
    "an ok attempt with a blank path",
    { started_at: 1, ended_at: 2, outcome: "ok", path: " " },
  ],
  [
    "a failed attempt without a reason",
    { started_at: 1, ended_at: 2, outcome: "failed" },
  ],
  [
    "an end before its start",
    { started_at: 2, ended_at: 1, outcome: "failed", error: "x" },
  ],
  [
    "a time that is not epoch millis",
    { started_at: 1.5, ended_at: 2, outcome: "failed", error: "x" },
  ],
])("recordBackup refuses %s", async (_, backup) => {
  expect(await recordBackup(t.db, backup)).toMatchObject(validation);
});

test("hasOkBackup: false with only failed attempts, true once one succeeded", async () => {
  const own = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  try {
    expect(unwrap(await hasOkBackup(own.db))).toBe(false);
    unwrap(
      await recordBackup(own.db, {
        started_at: 1,
        ended_at: 2,
        outcome: "failed",
        error: "no key",
      }),
    );
    expect(unwrap(await hasOkBackup(own.db))).toBe(false);
    unwrap(
      await recordBackup(own.db, {
        started_at: 3,
        ended_at: 4,
        outcome: "ok",
        path: "/backups/c.db.enc",
      }),
    );
    expect(unwrap(await hasOkBackup(own.db))).toBe(true);
  } finally {
    own.cleanup();
  }
});
