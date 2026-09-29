import type { ColumnMap } from "./schema-columns.js";
import type { FleetDB } from "./schema-fleet.js";

// 012_fleet's part of COLUMNS (schema-columns.ts): the same column specs, restated for its tables.
const text = { type: "TEXT", notnull: true } as const;
const textNull = { type: "TEXT", notnull: false } as const;
const int = { type: "INTEGER", notnull: true } as const;
const intNull = { type: "INTEGER", notnull: false } as const;
const realNull = { type: "REAL", notnull: false } as const;
const id = { ...text, pk: 1 } as const;

export const FLEET_COLUMNS: Pick<ColumnMap, keyof FleetDB> = {
  budgets: {
    id,
    scope: text,
    scope_ref: textNull,
    period: text,
    cap_usd: realNull,
    cap_tokens: intNull,
    warn_pct: int,
    on_breach: text,
    updated_at: int,
  },
  backups: {
    id,
    started_at: int,
    ended_at: int,
    outcome: text,
    path: textNull,
    error: textNull,
  },
  // 019_attention_acks.
  attention_acks: {
    session_id: { ...text, pk: 1 },
    acked_at: int,
    acked_by: text,
  },
};
