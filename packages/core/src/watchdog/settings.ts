// The watchdog's own settings: 012 seeds the watchdog.* rows and 002
// autosplit.handoff_threshold. The retry-storm ones are admission's (readAdmissionSettings), so
// the gate and the watchdog cannot read different numbers. A missing row is a config error, never
// a default, as admission reads its own.
import { z } from "zod";
import { err, ok, type Result } from "../errors.js";

export const WATCHDOG_SETTING_KEYS = {
  silentMs: "watchdog.silent_ms",
  circuitFailedRuns: "watchdog.circuit_failed_runs",
  /** §7.5's threshold, shared with the split_candidate attention arm (Q2). */
  splitHandoffs: "autosplit.handoff_threshold",
  diskMinFreePct: "admission.disk_min_free_pct",
} as const;

const Rows = z.object({
  silentMs: z.int().positive(),
  circuitFailedRuns: z.int().positive(),
  splitHandoffs: z.int().positive(),
  diskMinFreePct: z.number().min(0).max(100),
});
export type WatchdogSettings = z.infer<typeof Rows>;

/** The watchdog's settings from the parsed settings rows. */
export function readWatchdogSettings(
  rows: ReadonlyMap<string, unknown>,
): Result<WatchdogSettings> {
  const parsed = Rows.safeParse(
    Object.fromEntries(
      Object.entries(WATCHDOG_SETTING_KEYS).map(([field, key]) => [
        field,
        rows.get(key),
      ]),
    ),
  );
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `watchdog settings: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}
