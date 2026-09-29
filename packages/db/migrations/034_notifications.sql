-- 034_notifications (M7): the notifier's outbox. The API tails the DB for moments the
-- operator must hear about (a question, a staffing proposal, a ticket for QA, a block, a failed Jira
-- sync, a budget warning, a human-only attention arm) and files each once, then delivers it per
-- channel with retries. All three tables are the API's to write (§9.5 amendment); the supervisor
-- never writes them. (Planned as 035, after 034: renumbered when that lands, since the
-- runner refuses gaps.)
--
--   notifications            one per moment. `dedupe_key` is UNIQUE: the writer inserts with ON
--               CONFLICT DO NOTHING, so a restart or a second tick never files one twice. `body` is
--               capped (Invariant 9); `link_path` is a GUI hash (`#/…`), never an absolute URL: the
--               origin is the shell-only `notify.base_url`, joined at send time. No destination,
--               URL or credential is ever here (§14 amendment): those live in the host store.
--   notification_deliveries  one per notification and channel: `pending` until sent, `skipped`
--               (disabled, not subscribed, not configured) or `failed` (retries spent, or refused).
--               `last_error` is scrubbed of every secret before it is written, and capped.
--   notification_cursors     the notifier's watermarks, one per source table (the last rowid it
--               read), advanced in the transaction that files what it read; a missing row is a
--               first boot, which starts from now rather than from history.
--
-- The notifier's settings are seeded INSERT OR IGNORE, as 012's: every channel off (the GUI asks
-- the operator to turn one on), each subscribed to every event kind (mask 127), quiet hours off;
-- and the three shell-only strings (recipient, sender, link origin) empty, which is unset.
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  event_kind   TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL UNIQUE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  ticket_id    TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body         TEXT NOT NULL CHECK (length(body) <= 1000),
  link_path    TEXT CHECK (link_path IS NULL OR (substr(link_path, 1, 2) = '#/' AND length(link_path) <= 500)),
  created_at   INTEGER NOT NULL
);
CREATE INDEX notifications_created ON notifications (created_at);

CREATE TABLE notification_deliveries (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  sent_at         INTEGER,
  PRIMARY KEY (notification_id, channel)
);
CREATE INDEX notification_deliveries_due ON notification_deliveries (state, next_attempt_at);

CREATE TABLE notification_cursors (
  source     TEXT PRIMARY KEY,
  last_seen  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES
  ('notify.poll_ms', '15000', unixepoch() * 1000),
  ('notify.mac.enabled', '0', unixepoch() * 1000),
  ('notify.mac.events', '127', unixepoch() * 1000),
  ('notify.ntfy.enabled', '0', unixepoch() * 1000),
  ('notify.ntfy.events', '127', unixepoch() * 1000),
  ('notify.webhook.enabled', '0', unixepoch() * 1000),
  ('notify.webhook.events', '127', unixepoch() * 1000),
  ('notify.email.enabled', '0', unixepoch() * 1000),
  ('notify.email.events', '127', unixepoch() * 1000),
  ('notify.quiet_start_hour', '-1', unixepoch() * 1000),
  ('notify.quiet_end_hour', '-1', unixepoch() * 1000),
  ('notify.email.to', '""', unixepoch() * 1000),
  ('notify.email.from', '""', unixepoch() * 1000),
  ('notify.base_url', '""', unixepoch() * 1000);
