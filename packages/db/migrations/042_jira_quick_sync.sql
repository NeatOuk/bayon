-- 042_jira_quick_sync (M8.5): how often the API's Jira timer runs its quick pass.
--
--   jira.quick_interval_ms  between two full syncs (033's jira.sync_interval_ms), each project with a
--               Jira source reads only the issues its query matches that changed since the last
--               pass, files and updates tickets from them, and parks none: parking needs the full
--               result. Every minute; 0 is off. INSERT OR IGNORE as in 033: an operator's own value
--               stays.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('jira.quick_interval_ms', '60000', unixepoch() * 1000);
