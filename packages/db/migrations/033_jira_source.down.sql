-- Reverts 033_jira_source: the timer's setting and every project's Jira source go, and with them
-- the mirror; the tickets it filed stay (origin `jira`), as any ticket does. jira_jql goes first:
-- its CHECK names the other two, and SQLite drops a column's own CHECK with the column.
DELETE FROM settings WHERE key = 'jira.sync_interval_ms';
ALTER TABLE workspaces DROP COLUMN jira_jql;
ALTER TABLE workspaces DROP COLUMN jira_email;
ALTER TABLE workspaces DROP COLUMN jira_url;
