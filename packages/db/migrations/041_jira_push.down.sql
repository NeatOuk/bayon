-- Reverts 041_jira_push: the outbox and its watermarks go, then the two workspace columns, the one
-- carrying the CHECK first (SQLite drops a column's own CHECK with it). Nothing in Jira is touched.
DROP TABLE jira_push_cursors;
DROP TABLE jira_pushes;
ALTER TABLE workspaces DROP COLUMN jira_comment_prs;
ALTER TABLE workspaces DROP COLUMN jira_status_map_json;
