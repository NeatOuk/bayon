import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedSpine, SPINE_SEED, tempDb, unwrap } from "./testing.js";

// 018_runs_ended_at_index: the index the retry_storm scans want, on an empty database
// and on one that already holds runs, up and down. The plan assertions are the point — an index
// that exists but that SQLite declines to use would fix nothing.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const INDEX = "ix_runs_state_ended_at";

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const Indexes = z.array(z.object({ name: z.string() }));
const indexNames = (db: Db): string[] =>
  Indexes.parse(
    rawOf(db)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all(),
  ).map((r) => r.name);

/** listPairFailuresSince's shape (packages/db/src/repos/admission.ts), as the planner sees it. */
const PAIR_FAILURES = `
  SELECT r.ended_at FROM runs AS r
  INNER JOIN sessions AS s ON s.id = r.session_id
  WHERE s.runner_id = ? AND s.executor_id = ?
    AND r.state = 'failed' AND r.error_class = 'runner_error' AND r.ended_at >= ?
  ORDER BY r.ended_at`;

const Plan = z.array(z.object({ detail: z.string() }));
const planOf = (db: Db, params: unknown[]): string =>
  Plan.parse(
    rawOf(db)
      .prepare(`EXPLAIN QUERY PLAN ${PAIR_FAILURES}`)
      .all(...params),
  )
    .map((r) => r.detail)
    .join(" · ");

const PAIR = [SPINE_SEED.runnerId, SPINE_SEED.executorId, 0];

/**
 * Without the index SQLite drives the join from a full table scan and sorts for the ORDER BY —
 * which table it scans depends on what it knows about row counts, so the invariant worth asserting
 * is that *some* scan and a sort are there, and that afterwards neither is.
 */
const scans = (plan: string): boolean => /\bSCAN\b/.test(plan);
const sorts = (plan: string): boolean => plan.includes("TEMP B-TREE");

test("018 on an empty database adds the index the storm scan uses; down removes it", async () => {
  const db = await dbAt(17);
  expect(indexNames(db)).not.toContain(INDEX);
  const before = planOf(db, PAIR);
  expect(scans(before)).toBe(true);
  expect(sorts(before)).toBe(true);

  unwrap(await migrateUp(db, { to: 18 }));
  expect(await version(db)).toBe(18);
  expect(indexNames(db)).toContain(INDEX);
  const after = planOf(db, PAIR);
  expect(after).toContain(INDEX);
  expect(scans(after)).toBe(false);
  expect(sorts(after)).toBe(false);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(17);
  expect(indexNames(db)).not.toContain(INDEX);
  expect(sorts(planOf(db, PAIR))).toBe(true);

  unwrap(await migrateUp(db, { to: 18 }));
  expect(indexNames(db)).toContain(INDEX);
});

test("018 on a database that already holds runs keeps every row, and the scan still reads them", async () => {
  const db = await dbAt(17);
  unwrap(await seedSpine(db, 17));
  const raw = rawOf(db);
  const run = raw.prepare(
    `INSERT INTO runs (id, session_id, seq, trigger, prompt_path, prompt_hash, context_hash,
       state, started_at, ended_at, error_class)
     VALUES (?, ?, ?, 'pulse', '/p', 'ph', 'ch', ?, 1, ?, ?)`,
  );
  const session = SPINE_SEED.sessionId;
  run.run("r1", session, 101, "failed", 100, "runner_error");
  run.run("r2", session, 102, "failed", 200, "runner_error");
  run.run("r3", session, 103, "failed", 250, "timeout");
  run.run("r4", session, 104, "ok", 300, null);

  const rows = (): unknown =>
    raw.prepare("SELECT count(*) AS n FROM runs").get();
  const before = rows();
  const failures = (): unknown => raw.prepare(PAIR_FAILURES).all(...PAIR);
  // Exactly the pair's runner_error failures, in ended_at order — the timeout and the ok run are
  // not failures of this kind, and must not appear before or after the index exists.
  const expected = [{ ended_at: 100 }, { ended_at: 200 }];
  expect(failures()).toEqual(expected);

  unwrap(await migrateUp(db, { to: 18 }));
  expect(rows()).toEqual(before);
  expect(planOf(db, PAIR)).toContain(INDEX);
  expect(failures()).toEqual(expected);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(17);
  expect(indexNames(db)).not.toContain(INDEX);
  expect(rows()).toEqual(before);
  expect(failures()).toEqual(expected);
});
