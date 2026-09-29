// Test support for the suite's own tests: a readable status list, the fixture's expected table, and
// load-scaled budgets for the suite on a loaded test host. Not product code (coverage excludes
// fixtures.ts).
import { spawn } from "node:child_process";
import { systemClock, type Clock, type ConformanceResult } from "@bayon/core";
import { OFFLINE_BUDGETS, type Budgets } from "./types.js";

/**
 * The suite on real processes (LocalExecutor, a fresh Node child per session) while the workspace
 * suite runs its files in parallel. Measured under two concurrent full runs: a child's
 * first record came up to ~600 ms after send, so a 500 ms hang budget killed it first and test 9
 * failed `first_event_seen`. The hang budget stays a real wall clock an order of magnitude past
 * that boot: the stalled run never ends on its own, so the watchdog still fires while the runner is
 * alive, at least `hangMs` after send. Grace bounds interrupt and stop; §15 #7's 5 s is unchanged.
 * `hangMs` here is a floor: `runUnderLoad` scales it to the machine's load.
 */
export const LOADED_PROCESS_BUDGETS: Budgets = {
  ...OFFLINE_BUDGETS,
  callMs: 20_000,
  turnMs: 20_000,
  hangMs: 6_000,
  graceMs: 2_000,
};

/** Boot samples per calibration: their median ignores one outlier spawn either way. */
const BOOT_SAMPLES = 3;

/**
 * The ceiling on the scaled hang budget. Test 9 waits all of it on every run, green ones included,
 * and `runUnderLoad` may run the suite twice. A green fixture suite took 10.3–10.7 s at load 20–36
 * with a 6 s hang, so everything but that wait costs ~4.5 s; allow 4× (~20 s) on a host loaded
 * enough to reach the cap. Worst case: 2 × (30 s + 20 s) = 100 s, 20 s under suite.fixture.test.ts's
 * 120 s timeout (the adapter stub suite's test has 300 s).
 */
export const MAX_LOADED_HANG_MS = 30_000;

/** How a suite's hang budget follows a measured boot: `base.hangMs` is the floor. */
export interface HangScale {
  readonly base: Budgets;
  /** Boots of a bare Node child the stalled run's hang budget spans. */
  readonly perBoot: number;
  /** The ceiling, with headroom under the suite's vitest timeout for two runs. */
  readonly maxHangMs: number;
}

/** Real processes: each run's first record comes one child boot after send. */
export const LOADED_PROCESS_SCALE: HangScale = {
  base: LOADED_PROCESS_BUDGETS,
  perBoot: 20,
  maxHangMs: MAX_LOADED_HANG_MS,
};

/**
 * Time from spawning a bare Node child to its first stdout byte: the boot a real-process run pays
 * between send and its first record, sampled on the machine's load right now.
 */
export function bootLatencyMs(clock: Clock = systemClock): Promise<number> {
  const t0 = clock.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('1')"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.once("error", reject);
    child.stdout.once("data", () => resolve(clock.now() - t0));
    child.once("close", () =>
      reject(new Error("the boot probe exited without writing")),
    );
  });
}

/** The median of `n` boot samples, taken one after another: parallel probes would load the host. */
export async function medianBootMs(
  probe: () => Promise<number> = bootLatencyMs,
  n: number = BOOT_SAMPLES,
): Promise<number> {
  const ms: number[] = [];
  for (let i = 0; i < n; i += 1) ms.push(await probe());
  return ms.toSorted((a, b) => a - b)[Math.floor(n / 2)] ?? 0;
}

/**
 * `scale.base` with the hang budget scaled to a measured boot, between its floor and its cap. Test 9
 * stalls a run after its first record, so that record must beat the watchdog. Grace does not
 * scale: interrupt waits one grace before escalating, and the escalated run must still end inside
 * §15 #7's 5 s.
 */
export function scaledBudgets(scale: HangScale, bootMs: number): Budgets {
  const scaled = Math.ceil(scale.perBoot * bootMs);
  return {
    ...scale.base,
    hangMs: Math.min(scale.maxHangMs, Math.max(scale.base.hangMs, scaled)),
  };
}

/** LOADED_PROCESS_BUDGETS scaled to a measured boot. */
export const loadedBudgets = (bootMs: number): Budgets =>
  scaledBudgets(LOADED_PROCESS_SCALE, bootMs);

/**
 * Test 9 failed on `first_event_seen` alone, and every other failing test is exactly one the run
 * was expected to fail: the watchdog gave its timeout verdict on time to a live runner and no
 * invented terminal appeared, but the stalled run's first record had not arrived. That is the host's
 * load winning a race against the wall clock, not a verdict the runner got wrong. Never true when
 * 9 is expected to fail, so a rerun cannot turn a seeded test 9 bug into a pass, and never true
 * alongside any other unexpected failure, so a rerun cannot hide one.
 */
export function lostBootRace(
  r: Pick<ConformanceResult, "tests">,
  expectedFailed: readonly number[] = [],
): boolean {
  if (expectedFailed.includes(9)) return false;
  const nine = r.tests.find((t) => t.id === 9);
  const others = r.tests
    .filter((t) => t.id !== 9 && t.status !== "pass" && t.status !== "na")
    .map((t) => t.id);
  return (
    nine?.status === "fail" &&
    nine.checks
      .filter((c) => !c.ok)
      .map((c) => c.name)
      .join() === "first_event_seen" &&
    others.length === expectedFailed.length &&
    others.every((id) => expectedFailed.includes(id))
  );
}

export interface LoadOptions {
  /** A boot measurement; the median of three child boots unless a test injects one. */
  readonly sample?: () => Promise<number>;
  readonly scale?: HangScale;
  /** The tests the run must fail (a seeded bug's); none by default. */
  readonly expectedFailed?: readonly number[];
}

/**
 * Runs a suite on budgets scaled to a fresh boot sample. If the run lost a boot race anyway (a
 * load burst after the sample), it runs the whole suite once more on a new sample, and the caller
 * judges that run in full. The product suite itself never retries test 9: only
 * this harness absorbs the test host's load.
 */
export async function runUnderLoad<R extends Pick<ConformanceResult, "tests">>(
  run: (budgets: Budgets) => Promise<R>,
  o: LoadOptions = {},
): Promise<R> {
  const sample = o.sample ?? medianBootMs;
  const scale = o.scale ?? LOADED_PROCESS_SCALE;
  const first = await run(scaledBudgets(scale, await sample()));
  return lostBootRace(first, o.expectedFailed)
    ? run(scaledBudgets(scale, await sample()))
    : first;
}

/** Each test's status; anything not passing also shows its first failed check, for a readable diff. */
export const statuses = (r: ConformanceResult): string[] =>
  r.tests.map((t) => {
    const failed = t.checks.find((c) => !c.ok);
    return t.status === "pass" || t.status === "na" || failed === undefined
      ? `${t.id} ${t.status}`
      : `${t.id} ${t.status}: ${failed.name} ${failed.detail ?? ""}`.trim();
  });

/** What the fixture must show: every test passes but 12 and 13, N/A through their fallbacks. */
export const FIXTURE_EXPECTED: readonly string[] = [
  "1 pass",
  "2 pass",
  "3 pass",
  "4 pass",
  "5 pass",
  "6 pass",
  "7 pass",
  "8 pass",
  "9 pass",
  "10 pass",
  "11 pass",
  "12 na",
  "13 na",
  "14 pass",
  "15 pass",
  "16 pass",
];
