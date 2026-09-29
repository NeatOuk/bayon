// Executor health v1 (§6, §6.1, §13.2; "Amendments — M4": Executor.health() joins the executor
// contract). The one shape every executor's health() reports and the supervisor records
// as executors.health_detail, the limits a check is judged against, and the judges the kinds
// share. Limits are settings (config over code, §4): the defaults below are the M4 contract's and
// apply only to a missing row (012 seeds both).
import { z } from "zod";
import { err, ok, type Result } from "./errors.js";
import { EpochMs } from "./events/schema.js";

/** The `settings` rows a health check is judged against. */
export const HEALTH_SETTING_KEYS = [
  "executor.clock_skew_max_ms",
  "admission.disk_min_free_pct",
] as const;

/** The two settings, as the limits a check takes. */
export const HealthLimitsSettings = z
  .object({
    "executor.clock_skew_max_ms": z.int().positive().default(5_000),
    "admission.disk_min_free_pct": z.number().min(0).max(100).default(10),
  })
  .transform((s) => ({
    /** Skew at most this, either way, passes. */
    clockSkewMaxMs: s["executor.clock_skew_max_ms"],
    /** A measured path with less free disk than this, in %, fails. */
    minFreePct: s["admission.disk_min_free_pct"],
  }));
export type HealthLimits = z.output<typeof HealthLimitsSettings>;

/** The limits from getSettings' values; a missing row takes its default, a bad one is refused. */
export function healthLimits(
  values: ReadonlyMap<string, unknown>,
): Result<HealthLimits> {
  const present = HEALTH_SETTING_KEYS.flatMap((k) =>
    values.has(k) ? [[k, values.get(k)] as const] : [],
  );
  const parsed = HealthLimitsSettings.safeParse(Object.fromEntries(present));
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `health settings: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}

/** An executor's own limit can only tighten the fleet's: the smaller skew, the higher floor. */
export function stricterLimits(
  fleet: HealthLimits,
  own: Partial<HealthLimits>,
): HealthLimits {
  return {
    clockSkewMaxMs: Math.min(
      fleet.clockSkewMaxMs,
      own.clockSkewMaxMs ?? Number.POSITIVE_INFINITY,
    ),
    minFreePct: Math.max(
      fleet.minFreePct,
      own.minFreePct ?? Number.NEGATIVE_INFINITY,
    ),
  };
}

/** Free disk at one path that matters to the executor; `error` when it could not be measured. */
export const DiskReading = z.object({
  path: z.string().min(1),
  free_pct: z.number().min(0).max(100).nullable(),
  error: z.string().nullable(),
});
export type DiskReading = z.infer<typeof DiskReading>;

/** A runner's version as the health pass re-detected it on the executor (adapter.health). */
export const RunnerReading = z.object({
  version: z.string().nullable(),
  error: z.string().nullable(),
});
export type RunnerReading = z.infer<typeof RunnerReading>;

/** What every executor's health() reports, beside whatever its kind adds (docker, image, …). */
export const ExecutorHealthFields = z.object({
  checked_at: EpochMs,
  /** The lowest free % over `disk`: what admission's `disk` gate reads. Null: none measured. */
  free_pct: z.number().min(0).max(100).nullable(),
  /** The floor this check judged `disk` against. */
  min_free_pct: z.number().min(0).max(100),
  disk: z.array(DiskReading),
  /** The executor's clock minus the supervisor's; 0 on the supervisor's own host. */
  clock_skew_ms: z.int().nullable(),
  clock_skew_max_ms: z.int().positive(),
  failures: z.array(z.string()),
  /** Reported, never a failure. */
  warnings: z.array(z.string()),
});
export type ExecutorHealthFields = z.infer<typeof ExecutorHealthFields>;

/** `executors.health_detail` as read back: the uniform fields, the runner versions the supervisor
 * adds, and a kind's own keys, kept. */
export const ExecutorHealthDetail = ExecutorHealthFields.extend({
  runners: z.record(z.string(), RunnerReading).optional(),
}).loose();
export type ExecutorHealthDetail = z.infer<typeof ExecutorHealthDetail>;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The lowest free % among the readings that measured one; null when none did. */
export function lowestFreePct(disk: readonly DiskReading[]): number | null {
  const measured = disk.flatMap((d) =>
    d.free_pct === null ? [] : [d.free_pct],
  );
  return measured.length === 0 ? null : round1(Math.min(...measured));
}

/** A failure per path under the floor, and per path that could not be measured. */
export function diskFailures(
  disk: readonly DiskReading[],
  minFreePct: number,
): string[] {
  return disk.flatMap((d) => {
    if (d.error !== null) return [`disk: ${d.path}: ${d.error}`];
    if (d.free_pct !== null && d.free_pct < minFreePct) {
      return [
        `disk: ${d.path}: ${round1(d.free_pct)} % free, under min_free_pct ${minFreePct}`,
      ];
    }
    return [];
  });
}

/** Skew at most `maxMs` either way passes (§6.1: "at most executor.clock_skew_max_ms"). */
export function clockFailures(skewMs: number, maxMs: number): string[] {
  return Math.abs(skewMs) > maxMs
    ? [`clock: skewed ${skewMs} ms (max ${maxMs})`]
    : [];
}

/** The uniform verdict from disk and clock measurements, plus any failures a kind adds. */
export function judgeExecutorHealth(o: {
  readonly checkedAt: number;
  readonly disk: readonly DiskReading[];
  readonly clockSkewMs: number;
  readonly limits: HealthLimits;
  readonly failures?: readonly string[];
  readonly warnings?: readonly string[];
}): { readonly healthy: boolean; readonly detail: ExecutorHealthFields } {
  const failures = [
    ...diskFailures(o.disk, o.limits.minFreePct),
    ...clockFailures(o.clockSkewMs, o.limits.clockSkewMaxMs),
    ...(o.failures ?? []),
  ];
  return {
    healthy: failures.length === 0,
    detail: {
      checked_at: o.checkedAt,
      free_pct: lowestFreePct(o.disk),
      min_free_pct: o.limits.minFreePct,
      disk: o.disk.map((d) => ({ ...d })),
      clock_skew_ms: o.clockSkewMs,
      clock_skew_max_ms: o.limits.clockSkewMaxMs,
      failures,
      warnings: [...(o.warnings ?? [])],
    },
  };
}
