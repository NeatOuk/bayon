import { describe, expect, test } from "vitest";
import {
  PULSE_WINDOW_MS,
  PulsePolicy,
  catchupAt,
  cronAt,
  extendBurst,
  nextWake,
  pulseJitter,
  rateCapped,
  type PulseHistory,
} from "./schedule.js";

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** agents.pulse_* at their §4 defaults: hybrid, 90 min, 60 s, 5 min, 8/hour, 5 %. */
const policy = (o: Partial<PulsePolicy> = {}): PulsePolicy =>
  PulsePolicy.parse({
    mode: "hybrid",
    intervalMs: 90 * MIN,
    debounceMs: MIN,
    minGapMs: 5 * MIN,
    maxPerHour: 8,
    jitterPct: 5,
    createdAt: T0,
    ...o,
  });

const NONE: PulseHistory = {
  lastAt: null,
  lastSeed: null,
  lastRanAt: null,
  ranAts: [],
};

/** A history whose last pulse ran at `at`, with id `seed`. */
const ranAt = (at: number, seed = "p1"): PulseHistory => ({
  lastAt: at,
  lastSeed: seed,
  lastRanAt: at,
  ranAts: [at],
});

describe("pulseJitter", () => {
  test("is 0 without a seed, stays in [-1, 1], and is stable per seed", () => {
    expect(pulseJitter(null)).toBe(0);
    const seeds = Array.from({ length: 200 }, (_, i) => `01HX${i}`);
    for (const seed of seeds) {
      const j = pulseJitter(seed);
      expect(j).toBeGreaterThanOrEqual(-1);
      expect(j).toBeLessThanOrEqual(1);
      expect(pulseJitter(seed)).toBe(j);
    }
    expect(new Set(seeds.map(pulseJitter)).size).toBeGreaterThan(150);
  });
});

describe("cron", () => {
  test("90 min ± 5 % after the last pulse, the same wake on every re-plan", () => {
    const p = policy();
    for (const seed of ["a", "b", "c", "01J0000000000000000000000Z"]) {
      const at = cronAt(p, ranAt(T0, seed));
      expect(at).toBeGreaterThanOrEqual(T0 + 85.5 * MIN);
      expect(at).toBeLessThanOrEqual(T0 + 94.5 * MIN);
      expect(cronAt(p, ranAt(T0, seed))).toBe(at);
    }
  });

  test("an agent that never pulsed is anchored on its creation, not on now (review M1)", () => {
    const p = policy({ mode: "interval", createdAt: T0 });
    expect(nextWake(p, NONE, null, T0 + 10 * MIN)).toEqual({
      at: T0 + 90 * MIN,
      trigger: "cron",
    });
  });

  test("interval ignores a burst; on_idle has no cron; manual never wakes", () => {
    const burst = extendBurst(null, T0 + 100 * MIN);
    const h = ranAt(T0);
    expect(nextWake(policy({ mode: "interval" }), h, burst, T0)?.trigger).toBe(
      "cron",
    );
    expect(nextWake(policy({ mode: "on_idle" }), h, null, T0)).toBeNull();
    expect(nextWake(policy({ mode: "manual" }), h, burst, T0)).toBeNull();
  });
});

describe("completion", () => {
  const p = policy({ jitterPct: 0 });
  const h = ranAt(T0);
  const at = (burst: Parameters<typeof extendBurst>[0], now: number) =>
    nextWake(p, h, burst, now);

  test("debounce: three completions in 40 s are one wake, 60 s after the last", () => {
    const start = T0 + 30 * MIN;
    let burst = extendBurst(null, start);
    burst = extendBurst(burst, start + 20_000);
    burst = extendBurst(burst, start + 40_000);
    expect(at(burst, start + 40_000)).toEqual({
      at: start + 100_000,
      trigger: "completion",
    });
  });

  test("a burst that keeps coming never waits past the gap from its first completion", () => {
    const start = T0 + 30 * MIN;
    let burst = extendBurst(null, start);
    for (let t = 50_000; t <= 10 * MIN; t += 50_000) {
      burst = extendBurst(burst, start + t);
    }
    expect(at(burst, start + 10 * MIN)?.at).toBe(start + 5 * MIN);
  });

  test("the floor: a completion 1 min after a pulse waits for the 5 min gap", () => {
    const burst = extendBurst(null, T0 + MIN);
    expect(at(burst, T0 + MIN)).toEqual({
      at: T0 + 5 * MIN,
      trigger: "completion",
    });
  });

  test("the earlier of cron and completion wins", () => {
    // A burst just before the 90 min cron: its debounced wake (90.5 min) comes after the cron's.
    const late = extendBurst(null, T0 + 89.5 * MIN);
    expect(at(late, T0 + 89.5 * MIN)).toEqual({
      at: T0 + 90 * MIN,
      trigger: "cron",
    });
  });

  test("a cron wake held back by a leased pulse yields to a later burst: the follow-up is the completion's", () => {
    // The real run: a 20 s interval, P1 at T0 held the lease for 36 s, and the hand-off
    // finalized at +35.2 s. The cron wake (T0 + 20 s) came due before the burst began.
    const fast = policy({
      intervalMs: 20_000,
      debounceMs: 1_000,
      minGapMs: 2_000,
      maxPerHour: 60,
      jitterPct: 0,
    });
    const burst = extendBurst(null, T0 + 35_200);
    expect(nextWake(fast, ranAt(T0), burst, T0 + 36_000)).toEqual({
      at: T0 + 36_200,
      trigger: "completion",
    });
    // The gap still holds.
    const gapped = policy({ ...fast, minGapMs: MIN });
    expect(nextWake(gapped, ranAt(T0), burst, T0 + 36_000)).toEqual({
      at: T0 + MIN,
      trigger: "completion",
    });
  });

  test("extendBurst keeps the first and the last", () => {
    const b = extendBurst(extendBurst(null, 10), 5);
    expect(b).toEqual({ firstAt: 5, lastAt: 10 });
  });
});

describe("the rate cap", () => {
  const p = policy({ minGapMs: MIN, jitterPct: 0 });
  const eight = Array.from({ length: 8 }, (_, i) => T0 + i * 7 * MIN);
  const full: PulseHistory = {
    lastAt: eight.at(-1) ?? null,
    lastSeed: "p8",
    lastRanAt: eight.at(-1) ?? null,
    ranAts: eight,
  };
  const now = T0 + 50 * MIN;

  test("eight that ran in the trailing hour cap; the window slides", () => {
    expect(rateCapped(p, full, now)).toBe(true);
    expect(rateCapped(p, full, T0 + PULSE_WINDOW_MS)).toBe(false);
    expect(rateCapped(p, { ...full, ranAts: eight.slice(1) }, now)).toBe(false);
  });

  test("capped, no burst: the wake is cron, no earlier than the window has room", () => {
    const wake = nextWake(p, full, null, now);
    expect(wake?.trigger).toBe("cron");
    expect(wake?.at).toBe(Math.max(cronAt(p, full), T0 + PULSE_WINDOW_MS));
    const fast = policy({ intervalMs: MIN, minGapMs: 0, jitterPct: 0 });
    expect(nextWake(fast, full, null, now)?.at).toBe(T0 + PULSE_WINDOW_MS);
  });

  test("capped, a burst pending: it wakes once, so the lease records the breach", () => {
    const burst = extendBurst(null, now);
    expect(nextWake(p, full, burst, now)).toEqual({
      at: now + MIN,
      trigger: "completion",
    });
    // interval ignores completions, capped or not.
    const interval = policy({ mode: "interval", minGapMs: MIN, jitterPct: 0 });
    expect(nextWake(interval, full, burst, now)?.trigger).toBe("cron");
  });

  test("on_idle falls back to the interval while capped", () => {
    const idle = policy({ mode: "on_idle", minGapMs: MIN });
    expect(nextWake(idle, full, null, now)?.trigger).toBe("cron");
  });
});

describe("catchup", () => {
  test("hybrid and on_idle: one wake now, after the gap; however long the downtime", () => {
    const tenHours = T0 + 600 * MIN;
    expect(catchupAt(policy(), ranAt(T0), tenHours)).toBe(tenHours);
    expect(catchupAt(policy({ mode: "on_idle" }), NONE, tenHours)).toBe(
      tenHours,
    );
    expect(catchupAt(policy(), ranAt(T0), T0 + MIN)).toBe(T0 + 5 * MIN);
  });

  test("interval: only when the cron wake is overdue", () => {
    const p = policy({ mode: "interval", jitterPct: 0 });
    expect(catchupAt(p, ranAt(T0), T0 + 30 * MIN)).toBeNull();
    expect(catchupAt(p, ranAt(T0), T0 + 600 * MIN)).toBe(T0 + 600 * MIN);
  });

  test("manual: never", () => {
    expect(catchupAt(policy({ mode: "manual" }), NONE, T0)).toBeNull();
  });
});

test("the policy schema refuses a zero interval and a jitter over 100 %", () => {
  expect(PulsePolicy.safeParse({ ...policy(), intervalMs: 0 }).success).toBe(
    false,
  );
  expect(PulsePolicy.safeParse({ ...policy(), jitterPct: 101 }).success).toBe(
    false,
  );
});
