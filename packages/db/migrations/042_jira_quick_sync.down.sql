-- Reverts 042_jira_quick_sync: the quick pass's setting goes, and with it the quick pass; the full
-- sync (033) runs on as before.
DELETE FROM settings WHERE key = 'jira.quick_interval_ms';
