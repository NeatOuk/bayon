import type { Generated, Selectable } from "kysely";

// Hand-written Kysely types for 041_jira_push. schema-columns-jira-push.ts restates them
// at runtime, and schema.test.ts checks that against PRAGMA table_info. Both are API-written (§9.5).

/** One push to a mirrored ticket's Jira issue, filed once by its dedupe key. */
export interface JiraPushesTable {
  id: string;
  ticket_id: string;
  workspace_id: string;
  issue_key: string;
  /** `transition` or `comment` (CHECK). */
  kind: string;
  /** core JiraPushMoment (CHECK). */
  moment: string;
  /** core JiraTransitionPayload or JiraCommentPayload, by kind. */
  payload_json: string;
  dedupe_key: string;
  state: Generated<"pending" | "sent" | "skipped" | "failed">;
  attempts: Generated<number>;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  /** Scrubbed of the token, at most 500 characters (CHECK). */
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

/** The pusher's watermark on one source table. */
export interface JiraPushCursorsTable {
  source: string;
  last_seen: number;
  updated_at: number;
}

export interface JiraPushDB {
  jira_pushes: JiraPushesTable;
  jira_push_cursors: JiraPushCursorsTable;
}

export type JiraPushRow = Selectable<JiraPushesTable>;
