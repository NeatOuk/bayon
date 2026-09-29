// The kill switch (§13.3; M4 amendment "pause and budget breach share one gate"):
// `fleet.paused` as every reader parses it, and when a gate that could not launch while the fleet
// was paused starts its wall clock.
import { ADMISSION_SETTING_KEYS, SettingFlag } from "./admission.js";
import { err, ok, type Result } from "./errors.js";

export const FLEET_PAUSED_KEY = ADMISSION_SETTING_KEYS.paused;

/** A settings row as the database keeps it: the parsed value and when it was last written. */
export interface StoredSetting {
  readonly value: unknown;
  readonly updated_at: number;
}

/**
 * Whether the fleet is held, and since when it runs again. `resumedAt` is the last write of
 * `fleet.paused` while it reads 0: only migration 012's seed and the audited pause and resume
 * (db fleet-control.ts, which skips a write that changes nothing) write it, and seedConfig refuses
 * it, so that is the last resume (or the seed, before any pause); null while paused.
 */
export interface FleetHold {
  readonly paused: boolean;
  readonly resumedAt: number | null;
}

/** The hold from `fleet.paused`'s row. A missing or unreadable row is a config error, as it is to admission. */
export function fleetHoldOf(row: StoredSetting | undefined): Result<FleetHold> {
  if (row === undefined) {
    return err({
      class: "validation",
      message: `${FLEET_PAUSED_KEY} is missing (migration 012 seeds it)`,
      retryable: false,
    });
  }
  const paused = SettingFlag.safeParse(row.value);
  if (!paused.success) {
    return err({
      class: "validation",
      message: `${FLEET_PAUSED_KEY} must be 0 or 1`,
      retryable: false,
    });
  }
  return ok({
    paused: paused.data,
    resumedAt: paused.data ? null : row.updated_at,
  });
}

/**
 * The deadline of a gate that has no reviewer yet. Nothing launches while the fleet is paused, so
 * its wall clock runs from when it could first launch: the later of its start and the last resume.
 * A reviewer already running keeps the deadline it launched with.
 */
export const unlaunchedGateDeadline = (o: {
  readonly startedAt: number;
  readonly wallClockMs: number;
  readonly resumedAt: number | null;
}): number => Math.max(o.startedAt, o.resumedAt ?? o.startedAt) + o.wallClockMs;
