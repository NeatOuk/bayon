import { describe, expect, test } from "vitest";
import {
  ExecutorHealthDetail,
  clockFailures,
  diskFailures,
  healthLimits,
  judgeExecutorHealth,
  lowestFreePct,
  stricterLimits,
  type DiskReading,
} from "./executor-health.js";

const LIMITS = { clockSkewMaxMs: 5_000, minFreePct: 10 };
const reading = (path: string, free_pct: number | null): DiskReading => ({
  path,
  free_pct,
  error: null,
});

describe("healthLimits", () => {
  test("reads both settings", () => {
    expect(
      healthLimits(
        new Map<string, unknown>([
          ["executor.clock_skew_max_ms", 2_000],
          ["admission.disk_min_free_pct", 25],
        ]),
      ),
    ).toEqual({ ok: true, value: { clockSkewMaxMs: 2_000, minFreePct: 25 } });
  });

  test("a missing row takes the M4 contract's default", () => {
    expect(healthLimits(new Map())).toEqual({
      ok: true,
      value: { clockSkewMaxMs: 5_000, minFreePct: 10 },
    });
  });

  test.each([
    ["executor.clock_skew_max_ms", -1],
    ["executor.clock_skew_max_ms", "5000"],
    ["admission.disk_min_free_pct", 101],
    ["admission.disk_min_free_pct", null],
  ])("a bad %s (%j) is refused, never defaulted", (key, value) => {
    const got = healthLimits(new Map<string, unknown>([[key, value]]));
    expect(got).toMatchObject({ ok: false, error: { class: "validation" } });
    if (!got.ok) expect(got.error.message).toContain(key);
  });
});

test("an executor's own limits only tighten the fleet's", () => {
  expect(stricterLimits(LIMITS, {})).toEqual(LIMITS);
  expect(
    stricterLimits(LIMITS, { clockSkewMaxMs: 1_000, minFreePct: 15 }),
  ).toEqual({ clockSkewMaxMs: 1_000, minFreePct: 15 });
  expect(
    stricterLimits(LIMITS, { clockSkewMaxMs: 9_000, minFreePct: 5 }),
  ).toEqual(LIMITS);
});

describe("disk", () => {
  test("the lowest measured free % is what admission's disk gate reads; none measured is null", () => {
    expect(lowestFreePct([reading("/a", 40.04), reading("/b", 12.34)])).toBe(
      12.3,
    );
    expect(
      lowestFreePct([{ path: "/a", free_pct: null, error: "EACCES" }]),
    ).toBeNull();
    expect(lowestFreePct([])).toBeNull();
  });

  test("below the floor fails, naming the path; at the floor passes; unmeasured fails", () => {
    expect(diskFailures([reading("/w", 9.44)], 10)).toEqual([
      "disk: /w: 9.4 % free, under min_free_pct 10",
    ]);
    expect(diskFailures([reading("/w", 10)], 10)).toEqual([]);
    expect(
      diskFailures([{ path: "/w", free_pct: null, error: "EACCES" }], 10),
    ).toEqual(["disk: /w: EACCES"]);
  });
});

test("clock skew at most the max passes, either way; past it fails", () => {
  expect(clockFailures(5_000, 5_000)).toEqual([]);
  expect(clockFailures(-5_000, 5_000)).toEqual([]);
  expect(clockFailures(5_001, 5_000)).toEqual([
    "clock: skewed 5001 ms (max 5000)",
  ]);
  expect(clockFailures(-7_000, 5_000)).toEqual([
    "clock: skewed -7000 ms (max 5000)",
  ]);
});

describe("judgeExecutorHealth", () => {
  test("healthy: the uniform detail, parseable as health_detail", () => {
    const got = judgeExecutorHealth({
      checkedAt: 7,
      disk: [reading("/w", 50), reading("/m", 30)],
      clockSkewMs: 0,
      limits: LIMITS,
    });
    expect(got).toEqual({
      healthy: true,
      detail: {
        checked_at: 7,
        free_pct: 30,
        min_free_pct: 10,
        disk: [reading("/w", 50), reading("/m", 30)],
        clock_skew_ms: 0,
        clock_skew_max_ms: 5_000,
        failures: [],
        warnings: [],
      },
    });
    expect(ExecutorHealthDetail.parse(got.detail)).toEqual(got.detail);
  });

  test("disk below the floor: unhealthy, and the detail says which path", () => {
    const got = judgeExecutorHealth({
      checkedAt: 7,
      disk: [reading("/w", 50), reading("/m", 4)],
      clockSkewMs: 0,
      limits: LIMITS,
    });
    expect(got.healthy).toBe(false);
    expect(got.detail).toMatchObject({
      free_pct: 4,
      failures: ["disk: /m: 4 % free, under min_free_pct 10"],
    });
  });

  test("clock skew above the max: unhealthy", () => {
    const got = judgeExecutorHealth({
      checkedAt: 7,
      disk: [],
      clockSkewMs: 6_000,
      limits: LIMITS,
    });
    expect(got).toMatchObject({
      healthy: false,
      detail: {
        free_pct: null,
        failures: ["clock: skewed 6000 ms (max 5000)"],
      },
    });
  });

  test("a kind's own failures count; warnings never do", () => {
    const got = judgeExecutorHealth({
      checkedAt: 7,
      disk: [],
      clockSkewMs: 0,
      limits: LIMITS,
      failures: ["docker: the daemon does not answer"],
      warnings: ["build: leftovers"],
    });
    expect(got.healthy).toBe(false);
    expect(got.detail.warnings).toEqual(["build: leftovers"]);
    expect(
      judgeExecutorHealth({
        checkedAt: 7,
        disk: [],
        clockSkewMs: 0,
        limits: LIMITS,
        warnings: ["build: leftovers"],
      }).healthy,
    ).toBe(true);
  });
});

test("health_detail keeps a kind's own keys and the runner readings", () => {
  const detail = {
    checked_at: 1,
    free_pct: 20,
    min_free_pct: 15,
    disk: [reading("/r", 20)],
    clock_skew_ms: 40,
    clock_skew_max_ms: 5_000,
    failures: [],
    warnings: [],
    docker: "29.1.3",
    runners: { fixture: { version: "1", error: null } },
  };
  expect(ExecutorHealthDetail.parse(detail)).toEqual(detail);
  expect(
    ExecutorHealthDetail.safeParse({ ...detail, free_pct: "20" }).success,
  ).toBe(false);
});
