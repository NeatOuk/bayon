import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "./testing.js";

// 017_run_class_ceilings: the seeded run classes raised to what a real session needs,
// only where a row still holds 002's values in every column; down restores 002's only where a row
// still holds 017's. On an empty database, a seeded one, and with rows the operator tuned.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;

const Row = z.object({
  name: z.string(),
  context_tokens_cap: z.number(),
  max_turns: z.number(),
  max_tool_calls: z.number(),
  wall_clock_ms: z.number(),
  cost_cap_usd: z.number(),
  handoff_at_turns: z.number(),
  handoff_at_context_pct: z.number(),
  default_tier: z.string(),
});
type Row = z.infer<typeof Row>;

/** context cap, max turns, tool calls, wall clock, cost, hand-off turns, hand-off ctx %, tier. */
type Values = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  string,
];

const SEEDED_002: Readonly<Record<string, Values>> = {
  spike: [15_000, 40, 120, 2_700_000, 2, 30, 70, "standard"],
  build: [25_000, 120, 500, 7_200_000, 6, 90, 70, "standard"],
  fix: [15_000, 60, 200, 3_600_000, 2, 45, 70, "standard"],
  build_complex: [40_000, 250, 1_200, 14_400_000, 15, 180, 70, "complex"],
  review: [30_000, 30, 80, 1_800_000, 3, 0, 0, "standard"],
};
const RAISED_017: Readonly<Record<string, Values>> = {
  spike: [150_000, 100, 300, 2_700_000, 5, 75, 70, "standard"],
  build: [300_000, 300, 1_200, 7_200_000, 15, 225, 70, "standard"],
  fix: [150_000, 150, 500, 3_600_000, 5, 112, 70, "standard"],
  build_complex: [600_000, 500, 2_000, 14_400_000, 30, 375, 70, "complex"],
  review: [150_000, 60, 200, 1_800_000, 5, 0, 0, "standard"],
};
const RAISED = Object.keys(RAISED_017);

const valuesOf = (r: Row): Values => [
  r.context_tokens_cap,
  r.max_turns,
  r.max_tool_calls,
  r.wall_clock_ms,
  r.cost_cap_usd,
  r.handoff_at_turns,
  r.handoff_at_context_pct,
  r.default_tier,
];

/** Every run_classes row by name. */
const classesOf = (db: Db): Record<string, Row> =>
  Object.fromEntries(
    z
      .array(Row)
      .parse(rawOf(db).prepare("SELECT * FROM run_classes ORDER BY name").all())
      .map((r) => [r.name, r]),
  );

/** The five classes 017 raises, as value tuples. */
const raisedClassesOf = (db: Db): Record<string, Values> => {
  const rows = classesOf(db);
  return Object.fromEntries(
    RAISED.flatMap((name) => {
      const row = rows[name];
      return row === undefined ? [] : [[name, valuesOf(row)]];
    }),
  );
};

/** Every row except the five, whole: 017 never touches them. */
const othersOf = (db: Db): Row[] =>
  Object.values(classesOf(db)).filter((r) => !RAISED.includes(r.name));

const tune = (db: Db, sql: string): void => {
  rawOf(db).prepare(sql).run();
};

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

test("017 on an empty database: the five seeded classes raised, pulse, qa and probe untouched; down restores 002's", async () => {
  const db = await dbAt(16);
  expect(raisedClassesOf(db)).toEqual(SEEDED_002);
  const others = othersOf(db);
  expect(others.map((r) => r.name)).toEqual(["probe", "pulse", "qa"]);

  unwrap(await migrateUp(db, { to: 17 }));
  expect(await version(db)).toBe(17);
  expect(raisedClassesOf(db)).toEqual(RAISED_017);
  expect(othersOf(db)).toEqual(others);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(16);
  expect(raisedClassesOf(db)).toEqual(SEEDED_002);
  expect(othersOf(db)).toEqual(others);

  unwrap(await migrateUp(db, { to: 17 }));
  expect(raisedClassesOf(db)).toEqual(RAISED_017);
});

test("017 on a seeded database: a session on a seeded class keeps its row through up and down", async () => {
  const db = await dbAt(16);
  unwrap(await seedSpine(db, 16));
  tune(
    db,
    `UPDATE sessions SET run_class = 'spike' WHERE id = '${SPINE_SEED.sessionId}'`,
  );
  const sessionClass = () =>
    z
      .array(z.object({ run_class: z.string() }))
      .parse(rawOf(db).prepare("SELECT run_class FROM sessions").all());

  unwrap(await migrateUp(db, { to: 17 }));
  expect(sessionClass()).toEqual([{ run_class: "spike" }]);
  expect(raisedClassesOf(db)).toEqual(RAISED_017);
  // seedSpine's own class is no seeded row: 017 leaves it as seeded.
  expect(classesOf(db)[SPINE_SEED.runClass]).toBeDefined();
  const spine = classesOf(db)[SPINE_SEED.runClass];

  unwrap(await migrateDown(db));
  expect(sessionClass()).toEqual([{ run_class: "spike" }]);
  expect(raisedClassesOf(db)).toEqual(SEEDED_002);
  expect(classesOf(db)[SPINE_SEED.runClass]).toEqual(spine);
});

test("an operator-tuned row is never overwritten, by up or by down: one changed column keeps the whole row", async () => {
  const db = await dbAt(16);
  // Tuned before 017: one number, and one tier.
  tune(db, "UPDATE run_classes SET cost_cap_usd = 3 WHERE name = 'spike'");
  tune(
    db,
    "UPDATE run_classes SET default_tier = 'complex' WHERE name = 'review'",
  );
  const tunedSpike: Values = [
    15_000,
    40,
    120,
    2_700_000,
    3,
    30,
    70,
    "standard",
  ];
  const tunedReview: Values = [30_000, 30, 80, 1_800_000, 3, 0, 0, "complex"];

  unwrap(await migrateUp(db, { to: 17 }));
  expect(raisedClassesOf(db)).toEqual({
    ...RAISED_017,
    spike: tunedSpike,
    review: tunedReview,
  });

  unwrap(await migrateDown(db));
  expect(raisedClassesOf(db)).toEqual({
    ...SEEDED_002,
    spike: tunedSpike,
    review: tunedReview,
  });
});

test("down leaves a row the operator tuned after 017, and restores the rest", async () => {
  const db = await dbAt(17);
  tune(db, "UPDATE run_classes SET max_turns = 400 WHERE name = 'build'");
  unwrap(await migrateDown(db));
  expect(raisedClassesOf(db)).toEqual({
    ...SEEDED_002,
    build: [300_000, 400, 1_200, 7_200_000, 15, 225, 70, "standard"],
  });
});
