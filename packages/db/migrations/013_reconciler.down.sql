-- Reverts 013_reconciler: both columns go, and the setting 013 seeded.
ALTER TABLE runs DROP COLUMN wall_clock_ms;
ALTER TABLE sessions DROP COLUMN spawn_request_json;
DELETE FROM settings WHERE key = 'reconciler.command_max_attempts';
