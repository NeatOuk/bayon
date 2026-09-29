import type { Generated, Selectable } from "kysely";

// Hand-written Kysely types for 051_runner_updates. schema-columns-runner-updates.ts
// restates them at runtime, and schema.test.ts checks that against PRAGMA table_info. Conventions
// as in schema.ts.

/**
 * One (runner, latest) pair the supervisor's update check has ever seen (supervisor-owned, §9.5):
 * upserted every check, `found_at` set only on the first sighting.
 */
export interface RunnerUpdatesTable {
  runner_id: string;
  latest: string;
  current: string;
  /** 0 or 1: core `compareVersions(latest, current) > 0`, recomputed on every check. */
  newer: Generated<number>;
  notes_url: string | null;
  found_at: number;
  checked_at: number;
}

/** The operator's dismissal of one (runner, latest) row (API-owned, §9.5), audited. */
export interface RunnerUpdateDismissalsTable {
  runner_id: string;
  latest: string;
  dismissed_at: number;
  dismissed_by: string;
}

export interface RunnerUpdatesDB {
  runner_updates: RunnerUpdatesTable;
  runner_update_dismissals: RunnerUpdateDismissalsTable;
}

export type RunnerUpdateRow = Selectable<RunnerUpdatesTable>;
export type RunnerUpdateDismissalRow = Selectable<RunnerUpdateDismissalsTable>;
