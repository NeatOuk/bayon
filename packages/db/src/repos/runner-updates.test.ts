import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "../testing.js";
import { getFleetOverview } from "./fleet-overview.js";
import { upsertRegistration } from "./registration.js";
import {
  dismissRunnerUpdate,
  openRunnerUpdates,
  recordRunnerUpdate,
} from "./runner-updates.js";

// the runner update check's rows, against a real temp SQLite file (WAL matters). What
// matters: found_at is set once and never touched again; the open read is per runner, newest
// checked, newer-only, and dismissal drops it; a dismissal of an unseen pair is not_found and a
// repeat is idempotent.

const NOW = Date.UTC(2026, 8, 29, 10);
const HOUR = 3_600_000;

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function fresh(clock: FakeClock) {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 51));
  return t.db;
}

test("recordRunnerUpdate upserts by (runner_id, latest): found_at set once, current/newer/checked_at refreshed", async () => {
  const clock = new FakeClock(NOW);
  const db = await fresh(clock);
  const runnerId = SPINE_SEED.runnerId;

  const first = unwrap(
    await recordRunnerUpdate(db, {
      runner_id: runnerId,
      current: "0.3.283",
      latest: "0.3.290",
      newer: true,
      notes_url: "https://example.com/changelog",
    }),
  );
  expect(first).toMatchObject({
    runner_id: runnerId,
    latest: "0.3.290",
    current: "0.3.283",
    newer: 1,
    found_at: NOW,
    checked_at: NOW,
  });

  clock.advance(HOUR);
  const second = unwrap(
    await recordRunnerUpdate(db, {
      runner_id: runnerId,
      current: "0.3.283",
      latest: "0.3.290",
      newer: true,
    }),
  );
  // found_at never moves; checked_at does; notes_url without one this time clears it.
  expect(second).toMatchObject({
    found_at: NOW,
    checked_at: NOW + HOUR,
    notes_url: null,
  });
});

test("openRunnerUpdates: the newest-checked row per runner, newer only, dismissed ones dropped", async () => {
  const clock = new FakeClock(NOW);
  const db = await fresh(clock);
  const runnerId = SPINE_SEED.runnerId;

  // An older, stale row for the same runner (newer=1 but checked earlier) must not win.
  unwrap(
    await recordRunnerUpdate(db, {
      runner_id: runnerId,
      current: "0.3.283",
      latest: "0.3.284",
      newer: true,
    }),
  );
  clock.advance(HOUR);
  unwrap(
    await recordRunnerUpdate(db, {
      runner_id: runnerId,
      current: "0.3.283",
      latest: "0.3.290",
      newer: true,
      notes_url: "https://example.com/changelog",
    }),
  );

  const open = unwrap(await openRunnerUpdates(db));
  expect(open).toEqual([
    {
      runner_id: runnerId,
      current: "0.3.283",
      latest: "0.3.290",
      notes_url: "https://example.com/changelog",
      found_at: NOW + HOUR,
    },
  ]);

  // Once dismissed, the item is gone from the open read and from GET /fleet's runner_updates.
  unwrap(await dismissRunnerUpdate(db, runnerId, "0.3.290", "operator"));
  expect(unwrap(await openRunnerUpdates(db))).toEqual([]);
  const fleet = unwrap(await getFleetOverview(db));
  expect(fleet.runner_updates).toEqual([]);
});

test("openRunnerUpdates: a newer=0 row (an upgrade already applied) does not appear", async () => {
  const clock = new FakeClock(NOW);
  const db = await fresh(clock);
  const runnerId = SPINE_SEED.runnerId;
  unwrap(
    await recordRunnerUpdate(db, {
      runner_id: runnerId,
      current: "0.3.290",
      latest: "0.3.290",
      newer: false,
    }),
  );
  expect(unwrap(await openRunnerUpdates(db))).toEqual([]);
});

test("openRunnerUpdates: a stale row clears once the runner's live version catches up, even with no later check", async () => {
  const clock = new FakeClock(NOW);
  const db = await fresh(clock);
  const runnerId = SPINE_SEED.runnerId;

  unwrap(
    await recordRunnerUpdate(db, {
      runner_id: runnerId,
      current: "0.3.283",
      latest: "0.3.290",
      newer: true,
    }),
  );
  expect(unwrap(await openRunnerUpdates(db))).toHaveLength(1);

  // The operator upgrades and the runner is redetected at 0.3.290 (redetect), but no
  // later update-check pass has run to flip this row's `newer` back to 0 (checked off, npm
  // unreachable). The item must still stop showing.
  unwrap(
    await upsertRegistration(db, {
      runner: {
        id: runnerId,
        kind: "script",
        adapter: "fixture",
        version_detected: "0.3.290",
        caps_json: "{}",
      },
      models: [],
    }),
  );
  expect(unwrap(await openRunnerUpdates(db))).toEqual([]);
});

test.each([
  ["a version with a suffix, still behind", "0.3.283 (cli 2.1.283)", 1],
  ["a version with a suffix, caught up", "0.3.290 (cli 2.1.290)", 0],
  ["a version nothing can be read from", "unknown", 1],
])(
  "openRunnerUpdates: judges only the installed version's leading release (%s)",
  async (_what, detected, listed) => {
    const db = await fresh(new FakeClock(NOW));
    const runnerId = SPINE_SEED.runnerId;
    unwrap(
      await recordRunnerUpdate(db, {
        runner_id: runnerId,
        current: "0.3.283",
        latest: "0.3.290",
        newer: true,
      }),
    );
    unwrap(
      await upsertRegistration(db, {
        runner: {
          id: runnerId,
          kind: "script",
          adapter: "fixture",
          version_detected: detected,
          caps_json: "{}",
        },
        models: [],
      }),
    );
    expect(unwrap(await openRunnerUpdates(db))).toHaveLength(listed);
  },
);

test("dismissRunnerUpdate: not_found for an unseen pair; idempotent; audited", async () => {
  const clock = new FakeClock(NOW);
  const db = await fresh(clock);
  const runnerId = SPINE_SEED.runnerId;

  const missing = await dismissRunnerUpdate(db, runnerId, "9.9.9", "operator");
  expect(missing).toMatchObject({ ok: false, error: { class: "not_found" } });

  unwrap(
    await recordRunnerUpdate(db, {
      runner_id: runnerId,
      current: "0.3.283",
      latest: "0.3.290",
      newer: true,
    }),
  );
  const first = unwrap(
    await dismissRunnerUpdate(db, runnerId, "0.3.290", "operator"),
  );
  expect(first).toEqual({ runner_id: runnerId, latest: "0.3.290" });
  // A repeat is not an error: the strip reads the same either way.
  const again = unwrap(
    await dismissRunnerUpdate(db, runnerId, "0.3.290", "operator"),
  );
  expect(again).toEqual({ runner_id: runnerId, latest: "0.3.290" });
});
