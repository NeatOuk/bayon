import type { ColumnMap } from "./schema-columns.js";
import type { JiraPushDB } from "./schema-jira-push.js";

// 041_jira_push's part of COLUMNS (schema-columns.ts), restated for its tables.
const text = { type: "TEXT", notnull: true } as const;
const textNull = { type: "TEXT", notnull: false } as const;
const int = { type: "INTEGER", notnull: true } as const;
const intNull = { type: "INTEGER", notnull: false } as const;

export const JIRA_PUSH_COLUMNS: Pick<ColumnMap, keyof JiraPushDB> = {
  jira_pushes: {
    id: { ...text, pk: 1 },
    ticket_id: text,
    workspace_id: text,
    issue_key: text,
    kind: text,
    moment: text,
    payload_json: text,
    dedupe_key: text,
    state: text,
    attempts: int,
    next_attempt_at: intNull,
    last_attempt_at: intNull,
    last_error: textNull,
    created_at: int,
    sent_at: intNull,
  },
  jira_push_cursors: {
    source: { ...text, pk: 1 },
    last_seen: int,
    updated_at: int,
  },
};
