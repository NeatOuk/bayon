import type { ColumnMap } from "./schema-columns.js";
import type { RunnerUpdatesDB } from "./schema-runner-updates.js";

// 051_runner_updates' part of COLUMNS (schema-columns.ts), restated for its tables.
const text = { type: "TEXT", notnull: true } as const;
const textNull = { type: "TEXT", notnull: false } as const;
const int = { type: "INTEGER", notnull: true } as const;

export const RUNNER_UPDATES_COLUMNS: Pick<ColumnMap, keyof RunnerUpdatesDB> = {
  runner_updates: {
    runner_id: { ...text, pk: 1 },
    latest: { ...text, pk: 2 },
    current: text,
    newer: int,
    notes_url: textNull,
    found_at: int,
    checked_at: int,
  },
  runner_update_dismissals: {
    runner_id: { ...text, pk: 1 },
    latest: { ...text, pk: 2 },
    dismissed_at: int,
    dismissed_by: text,
  },
};
