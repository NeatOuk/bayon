// The local executor's health: real disks, the floor from the limits it is handed.
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutorHealthDetail } from "@bayon/core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { SlotCounter } from "../slots.js";
import { localHealth, measureDisk } from "./health.js";
import { LocalExecutor } from "./local.js";

const NO_FLOOR = { clockSkewMaxMs: 5_000, minFreePct: 0 };
const now = () => 7;
let dir = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "frm-health-")));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("a path not created yet is measured on the filesystem it will land on", async () => {
  const reading = await measureDisk(join(dir, "work", "not", "yet"));
  expect(reading.error).toBeNull();
  expect(reading.free_pct).toBeGreaterThan(0);
  expect(reading.free_pct).toBeLessThanOrEqual(100);
  expect(reading.path).toBe(join(dir, "work", "not", "yet"));
});

test("above the floor: healthy, and the clock is the supervisor's own (skew 0)", async () => {
  const report = await localHealth({
    paths: () => [dir],
    limits: NO_FLOOR,
    now,
  });
  expect(report.healthy).toBe(true);
  const detail = ExecutorHealthDetail.parse(report.detail);
  expect(detail).toMatchObject({
    checked_at: 7,
    clock_skew_ms: 0,
    clock_skew_max_ms: 5_000,
    min_free_pct: 0,
    failures: [],
  });
  expect(detail.free_pct).toBe(detail.disk[0]?.free_pct);
});

test("disk below the floor: unhealthy, the detail naming the path", async () => {
  const report = await localHealth({
    paths: () => [dir],
    limits: { clockSkewMaxMs: 5_000, minFreePct: 100 },
    now,
  });
  expect(report.healthy).toBe(false);
  expect(report.detail.min_free_pct).toBe(100);
  expect(report.detail.failures).toEqual([
    expect.stringMatching(
      new RegExp(`^disk: ${dir}: [\\d.]+ % free, under min_free_pct 100$`),
    ),
  ]);
});

test("a path that cannot be measured is a failure, never a rejection", async () => {
  const file = join(dir, "a-file");
  await writeFile(file, "x");
  const report = await localHealth({
    paths: () => [join(file, "below")],
    limits: NO_FLOOR,
    now,
  });
  expect(report.healthy).toBe(false);
  expect(report.detail.free_pct).toBeNull();
  expect(report.detail.failures).toEqual([
    expect.stringMatching(new RegExp(`^disk: ${file}/below: `)),
  ]);
});

test("a path listed twice is measured once; paths that cannot be listed are a failure", async () => {
  const twice = await localHealth({
    paths: async () => [dir, dir],
    limits: NO_FLOOR,
    now,
  });
  expect(twice.detail.disk).toHaveLength(1);
  const unlisted = await localHealth({
    paths: () => {
      throw new Error("the db is gone");
    },
    limits: NO_FLOOR,
    now,
  });
  expect(unlisted).toMatchObject({
    healthy: false,
    detail: {
      disk: [],
      free_pct: null,
      failures: ["disk: cannot list the paths to measure: the db is gone"],
    },
  });
});

test("LocalExecutor asks its diskPaths on every check: a repo added at runtime counts", async () => {
  const asked: string[][] = [[dir], [dir, join(dir, "mirror.git")]];
  let calls = 0;
  const ex = new LocalExecutor({
    id: "local",
    slots: new SlotCounter(1),
    diskPaths: () => asked[Math.min(calls++, asked.length - 1)] ?? [],
  });
  expect((await ex.health(NO_FLOOR)).detail.disk).toHaveLength(1);
  expect((await ex.health(NO_FLOOR)).detail.disk.map((d) => d.path)).toEqual([
    dir,
    join(dir, "mirror.git"),
  ]);
  expect(
    (
      await new LocalExecutor({ id: "l", slots: new SlotCounter(1) }).health(
        NO_FLOOR,
      )
    ).detail,
  ).toMatchObject({ disk: [], free_pct: null, failures: [] });
});
