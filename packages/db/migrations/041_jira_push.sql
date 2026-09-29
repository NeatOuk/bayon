-- 041_jira_push (M8.4): Jira follows the ticket. A mirrored ticket's moves and pull
-- requests go back to its Jira issue: a status transition at three moments, and a comment linking
-- each pull request. All four objects are the API's to write (§9.5 amendment); the supervisor
-- never writes them.
--
--   workspaces.jira_status_map_json  NULL (every project already here): move nothing. Otherwise a
--             JSON object {started?, in_review?, done?}, each a Jira status name, shaped by core's
--             JiraStatusMap at the one writer (PATCH /projects/:id, audited project.set); here only
--             held to valid JSON.
--   workspaces.jira_comment_prs  1: comment each pull request a delivery opens, and who merged it.
--             The CHECK is on the last column added, as 038's, so the down migration can drop them.
--   jira_pushes  the outbox, copied from 034's: one row per push, `dedupe_key` UNIQUE so a restart
--             or a second tick never files one twice. `payload_json` is small (a status name, or a
--             lead line and a few urls); `last_error` is scrubbed of the token by the API before it
--             gets here, and capped. No credential, URL of the site or token is ever stored (§14).
--   jira_push_cursors  the pusher's watermarks, one per source table (ticket_events by id,
--             ticket_links by rowid); a missing row is a first boot, which starts from now.
ALTER TABLE workspaces ADD COLUMN jira_status_map_json TEXT;
ALTER TABLE workspaces ADD COLUMN jira_comment_prs INTEGER NOT NULL DEFAULT 1
  CHECK (jira_comment_prs IN (0, 1)
         AND (jira_status_map_json IS NULL OR json_valid(jira_status_map_json)));

CREATE TABLE jira_pushes (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_key       TEXT NOT NULL CHECK (length(issue_key) BETWEEN 3 AND 64),
  kind            TEXT NOT NULL CHECK (kind IN ('transition', 'comment')),
  moment          TEXT NOT NULL CHECK (moment IN ('started', 'in_review', 'done')),
  payload_json    TEXT NOT NULL CHECK (length(payload_json) <= 8000 AND json_valid(payload_json)),
  dedupe_key      TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) <= 700),
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'sent', 'skipped', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX jira_pushes_due ON jira_pushes (state, next_attempt_at);
CREATE INDEX jira_pushes_ticket ON jira_pushes (ticket_id, kind, state);

CREATE TABLE jira_push_cursors (
  source     TEXT PRIMARY KEY,
  last_seen  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
