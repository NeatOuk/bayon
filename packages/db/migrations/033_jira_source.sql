-- 033_jira_source (M6): a project's Jira source, which the API mirrors one way into the
-- project's tickets (Jira -> Bayon), and how often its timer does so.
--
--   workspaces.jira_url    the site, `https://<name>.atlassian.net` exactly (proto JiraSource holds
--               it to that origin: the token is only ever sent to Atlassian's servers).
--   workspaces.jira_email  the Atlassian account the token belongs to (the Basic auth user).
--   workspaces.jira_jql    the query whose To Do issues the project mirrors.
--               Set together or not at all (the CHECK, on the last column as 032's pair): NULL is
--               no mirror. Columns beside 029's `paused` and 030's `staff_approval`, read with their
--               workspace. Written only by the API (POST /projects, PATCH /projects/:id), audited.
--               The token itself is never here: the API reads JIRA_API_TOKEN from the host secret
--               store at sync time (§14).
--   jira.sync_interval_ms  the API's timer, 15 min; 0 is off. INSERT OR IGNORE as in 012: an
--               operator's own value stays.
--
-- NULL for every workspace already there: nothing is mirrored by the migration.
ALTER TABLE workspaces ADD COLUMN jira_url TEXT;
ALTER TABLE workspaces ADD COLUMN jira_email TEXT;
ALTER TABLE workspaces ADD COLUMN jira_jql TEXT
  CHECK ((jira_jql IS NULL) = (jira_url IS NULL) AND (jira_jql IS NULL) = (jira_email IS NULL));

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('jira.sync_interval_ms', '900000', unixepoch() * 1000);
