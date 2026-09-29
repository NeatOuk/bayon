// GET /fleet's disk: each enabled executor's free disk from its last health check.
import { FakeClock, ok } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { execute, qb, write, type Db } from "../connection.js";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "../testing.js";
import { setExecutorHealth } from "./config.js";
import { getFleetOverview } from "./fleet-overview.js";

const NOW = Date.UTC(2026, 8, 14, 10);
const ID = SPINE_SEED.executorId;
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function fresh(): Promise<Db> {
  const t = unwrap(await tempDb(new FakeClock(NOW)));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 1));
  return t.db;
}

const diskOf = async (db: Db) =>
  unwrap(await getFleetOverview(db)).disk.find((d) => d.executor_id === ID);

const DETAIL = {
  checked_at: NOW - 5,
  free_pct: 41.5,
  min_free_pct: 10,
  disk: [{ path: "/frm/work", free_pct: 41.5, error: null }],
  clock_skew_ms: 0,
  clock_skew_max_ms: 5_000,
  failures: [],
  warnings: [],
};

test("never checked: listed, with nothing measured", async () => {
  expect(await diskOf(await fresh())).toEqual({
    executor_id: ID,
    free_pct: null,
    min_free_pct: null,
    checked_at: null,
  });
});

test("the last check's lowest free % and floor, stamped by the check", async () => {
  const db = await fresh();
  unwrap(await setExecutorHealth(db, ID, "healthy", DETAIL));
  expect(await diskOf(db)).toEqual({
    executor_id: ID,
    free_pct: 41.5,
    min_free_pct: 10,
    checked_at: NOW,
  });
});

test("a detail that measured no disk, or none at all, shows no measurement", async () => {
  const db = await fresh();
  unwrap(await setExecutorHealth(db, ID, "unhealthy", { failures: ["x"] }));
  expect(await diskOf(db)).toMatchObject({ free_pct: null, checked_at: NOW });
  unwrap(await setExecutorHealth(db, ID, "unhealthy", null));
  expect(await diskOf(db)).toMatchObject({
    free_pct: null,
    min_free_pct: null,
  });
});

test("a disabled executor is not listed", async () => {
  const db = await fresh();
  unwrap(
    await write(db, (ix) => {
      execute(
        ix,
        qb.updateTable("executors").set({ enabled: 0 }).where("id", "=", ID),
      );
      return ok(undefined);
    }),
  );
  expect(await diskOf(db)).toBeUndefined();
});
