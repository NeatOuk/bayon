-- Reverts 051_runner_updates: the two tables and the setting are gone; the operator sees no runner
-- update check, as before this migration.
DROP TABLE runner_update_dismissals;
DROP TABLE runner_updates;
DELETE FROM settings WHERE key = 'runners.update_check_hours';
