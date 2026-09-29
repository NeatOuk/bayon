import type { ColumnMap } from "./schema-columns.js";
import type { NotifyDB } from "./schema-notify.js";

// The notifications migration's part of COLUMNS (schema-columns.ts), restated for its tables.
const text = { type: "TEXT", notnull: true } as const;
const textNull = { type: "TEXT", notnull: false } as const;
const int = { type: "INTEGER", notnull: true } as const;
const intNull = { type: "INTEGER", notnull: false } as const;

export const NOTIFY_COLUMNS: Pick<ColumnMap, keyof NotifyDB> = {
  notifications: {
    id: { ...text, pk: 1 },
    event_kind: text,
    dedupe_key: text,
    workspace_id: textNull,
    ticket_id: textNull,
    title: text,
    body: text,
    link_path: textNull,
    created_at: int,
  },
  notification_deliveries: {
    notification_id: { ...text, pk: 1 },
    channel: { ...text, pk: 2 },
    state: text,
    attempts: int,
    last_error: textNull,
    next_attempt_at: intNull,
    last_attempt_at: intNull,
    sent_at: intNull,
  },
  notification_cursors: {
    source: { ...text, pk: 1 },
    last_seen: int,
    updated_at: int,
  },
};
