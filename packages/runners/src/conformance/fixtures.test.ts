// The load-scaled budgets and the one rerun the suites allow on a loaded host: the rerun
// happens only when the host's load lost test 9's race to its first record, never for a verdict,
// never for a test 9 failure the run was expected to show, and never beside another surprise.
import {
  CONFORMANCE_TEST_NAMES,
  type ConformanceResult,
  type ConformanceTestId,
} from "@bayon/core";
import { describe, expect, test } from "vitest";
import {
  LOADED_PROCESS_BUDGETS,
  MAX_LOADED_HANG_MS,
  bootLatencyMs,
  loadedBudgets,
  lostBootRace,
  medianBootMs,
  runUnderLoad,
  scaledBudgets,
  type HangScale,
} from "./fixtures.js";
import { OFFLINE_BUDGETS, type Budgets } from "./types.js";

type Tests = Pick<ConformanceResult, "tests">;
type TestResult = ConformanceResult["tests"][number];

const IDS: readonly ConformanceTestId[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
];

/** Every test passes; `failing` maps a test to the checks it fails. */
function result(
  failing: Partial<Record<ConformanceTestId, readonly string[]>> = {},
): Tests {
  const tests: TestResult[] = IDS.map((id) => {
    const bad = failing[id] ?? [];
    return {
      id,
      name: CONFORMANCE_TEST_NAMES[id],
      status: bad.length === 0 ? "pass" : "fail",
      attempts: 1,
      duration_ms: 1,
      fallback: null,
      checks: [
        { name: "ok_check", ok: true, detail: null },
        ...bad.map((name) => ({ name, ok: false, detail: null })),
      ],
    };
  });
  return { tests };
}

const FES = "first_event_seen";

describe("loadedBudgets", () => {
  test("a quiet machine gets the floor", () => {
    expect(loadedBudgets(40)).toEqual(LOADED_PROCESS_BUDGETS);
  });

  test("a slow boot scales the hang budget and nothing else", () => {
    expect(loadedBudgets(1_000.2)).toEqual({
      ...LOADED_PROCESS_BUDGETS,
      hangMs: 20_004,
    });
  });

  test("an extreme boot stops at the cap, under the suites' vitest timeouts", () => {
    expect(loadedBudgets(10_000)).toEqual({
      ...LOADED_PROCESS_BUDGETS,
      hangMs: MAX_LOADED_HANG_MS,
    });
    expect(loadedBudgets(1_501).hangMs).toBe(MAX_LOADED_HANG_MS);
    expect(loadedBudgets(1_500).hangMs).toBe(30_000);
    expect(2 * MAX_LOADED_HANG_MS).toBeLessThan(120_000);
  });
});

describe("scaledBudgets on a scale of its own", () => {
  const scale: HangScale = {
    base: { ...OFFLINE_BUDGETS, hangMs: 200, graceMs: 200 },
    perBoot: 10,
    maxHangMs: 10_000,
  };

  test("floor, then boots × perBoot, then the cap; grace never moves", () => {
    expect(scaledBudgets(scale, 15)).toEqual(scale.base);
    expect(scaledBudgets(scale, 300)).toEqual({ ...scale.base, hangMs: 3_000 });
    expect(scaledBudgets(scale, 5_000)).toEqual({
      ...scale.base,
      hangMs: 10_000,
    });
  });
});

describe("medianBootMs", () => {
  const probes = (...ms: number[]) => {
    const queue = [...ms];
    let calls = 0;
    const probe = () => {
      calls += 1;
      return Promise.resolve(queue.shift() ?? 0);
    };
    return { probe, calls: () => calls };
  };

  test("takes three samples and ignores one outlier either way", async () => {
    const high = probes(50, 9_000, 70);
    expect(await medianBootMs(high.probe)).toBe(70);
    expect(high.calls()).toBe(3);
    expect(await medianBootMs(probes(1, 80, 60).probe)).toBe(60);
  });

  test("one sample is its own median", async () => {
    expect(await medianBootMs(probes(42).probe, 1)).toBe(42);
  });

  test("samples one after another, never two probes in flight", async () => {
    let inFlight = 0;
    let most = 0;
    const probe = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return 10;
    };
    await medianBootMs(probe);
    expect(most).toBe(1);
  });
});

describe("lostBootRace", () => {
  test("only test 9, only first_event_seen", () => {
    expect(lostBootRace(result({ 9: [FES] }))).toBe(true);
  });

  test.each([
    ["everything passed", {}],
    ["fired_on_time failed too", { 9: [FES, "fired_on_time"] }],
    ["alive_when_fired failed too", { 9: [FES, "alive_when_fired"] }],
    ["a verdict check alone", { 9: ["no_runner_terminal"] }],
    ["another test failed too", { 7: ["within_budget"], 9: [FES] }],
    ["the same check on another test", { 10: [FES] }],
  ] as const)("not when %s", (_, failing) => {
    expect(lostBootRace(result(failing))).toBe(false);
  });

  test("not when test 9 is incomplete", () => {
    const r = result({ 9: [FES] });
    const tests = r.tests.map((t) =>
      t.id === 9 ? { ...t, status: "incomplete" as const } : t,
    );
    expect(lostBootRace({ tests })).toBe(false);
  });

  describe("beside a seeded bug's expected failures", () => {
    test("yes when every other failure is exactly the expected set", () => {
      const r = result({ 9: [FES], 14: ["second_claim_refused"] });
      expect(lostBootRace(r, [14])).toBe(true);
      const two = result({ 9: [FES], 10: ["unknown_stored"], 14: ["x"] });
      expect(lostBootRace(two, [10, 14])).toBe(true);
    });

    test.each([
      [
        "an unexpected failure beside it",
        { 9: [FES], 10: ["x"], 14: ["y"] },
        [14],
      ],
      ["the expected test did not fail", { 9: [FES] }, [14]],
      [
        "the expected test failed, another did not",
        { 9: [FES], 14: ["y"] },
        [10, 14],
      ],
      [
        "a verdict check on 9 failed too",
        { 9: [FES, "fired_on_time"], 10: ["x"] },
        [10],
      ],
    ] as const)("not when %s", (_, failing, expected) => {
      expect(lostBootRace(result(failing), expected)).toBe(false);
    });

    test("never when 9 is expected to fail: a seeded 9 bug cannot be rerun into a pass", () => {
      expect(lostBootRace(result({ 9: [FES] }), [9])).toBe(false);
      expect(
        lostBootRace(result({ 9: [FES], 10: ["x"], 14: ["y"] }), [9, 10, 14]),
      ).toBe(false);
      expect(
        lostBootRace(
          result({ 9: [FES, "no_runner_terminal"], 10: ["x"], 14: ["y"] }),
          [9, 10, 14],
        ),
      ).toBe(false);
    });
  });
});

describe("runUnderLoad", () => {
  const recorder = (outcomes: readonly Tests[]) => {
    const seen: Budgets[] = [];
    const run = (b: Budgets) => {
      seen.push(b);
      const next = outcomes[seen.length - 1];
      if (next === undefined) throw new Error("ran once too often");
      return Promise.resolve(next);
    };
    return { seen, run };
  };
  const samples = (...ms: number[]) => {
    const queue = [...ms];
    return () => Promise.resolve(queue.shift() ?? 0);
  };

  test("runs once on the sampled budgets when the run is final", async () => {
    const failedVerdict = result({ 9: ["fired_on_time"] });
    const r = recorder([failedVerdict]);
    expect(await runUnderLoad(r.run, { sample: samples(500) })).toBe(
      failedVerdict,
    );
    expect(r.seen.map((b) => b.hangMs)).toEqual([10_000]);
  });

  test("a lost boot race runs once more on a fresh sample, and that run is the result", async () => {
    const lost = result({ 9: [FES] });
    const r = recorder([lost, lost]);
    expect(await runUnderLoad(r.run, { sample: samples(100, 700) })).toBe(lost);
    expect(r.seen.map((b) => b.hangMs)).toEqual([6_000, 14_000]);
  });

  test("its own scale and expected failures: reruns beside a seeded 14, never beside a seeded 9", async () => {
    const scale: HangScale = {
      base: { ...OFFLINE_BUDGETS, hangMs: 200 },
      perBoot: 10,
      maxHangMs: 10_000,
    };
    const lost14 = result({ 9: [FES], 14: ["second_claim_refused"] });
    const r14 = recorder([lost14, lost14]);
    await runUnderLoad(r14.run, {
      sample: samples(10, 400),
      scale,
      expectedFailed: [14],
    });
    expect(r14.seen.map((b) => b.hangMs)).toEqual([200, 4_000]);

    const lost9 = result({ 9: [FES] });
    const r9 = recorder([lost9]);
    await runUnderLoad(r9.run, {
      sample: samples(10),
      scale,
      expectedFailed: [9],
    });
    expect(r9.seen).toHaveLength(1);
  });
});

test("bootLatencyMs times a real child's first byte", async () => {
  const ms = await bootLatencyMs();
  expect(ms).toBeGreaterThan(0);
  expect(Number.isFinite(ms)).toBe(true);
});
