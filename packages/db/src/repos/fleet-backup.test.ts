import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { tempDb, unwrap } from "../testing.js";
import { recordBackup } from "./backups.js";
import { getFleetOverview } from "./fleet-overview.js";

// GET /fleet gains backup (M4 §12.1): the newest attempt and the last good one.
const t = unwrap(await tempDb(new FakeClock(Date.UTC(2026, 8, 14, 9))));
afterAll(() => t.cleanup());

const backupOf = async () => unwrap(await getFleetOverview(t.db)).backup;

test("no attempt yet: nothing to show", async () => {
  expect(await backupOf()).toEqual({ last: null, last_ok_at: null });
});

test("the newest attempt, and when one last succeeded", async () => {
  unwrap(
    await recordBackup(t.db, {
      started_at: 100,
      ended_at: 200,
      outcome: "ok",
      path: "/home/backups/foreman-a.frmbak",
    }),
  );
  expect(await backupOf()).toEqual({
    last: {
      outcome: "ok",
      started_at: 100,
      ended_at: 200,
      path: "/home/backups/foreman-a.frmbak",
      error: null,
    },
    last_ok_at: 200,
  });
  unwrap(
    await recordBackup(t.db, {
      started_at: 300,
      ended_at: 301,
      outcome: "failed",
      error: "no backup key",
    }),
  );
  expect(await backupOf()).toEqual({
    last: {
      outcome: "failed",
      started_at: 300,
      ended_at: 301,
      path: null,
      error: "no backup key",
    },
    last_ok_at: 200,
  });
});
