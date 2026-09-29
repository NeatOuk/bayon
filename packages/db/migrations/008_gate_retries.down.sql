-- 008_gate_retries down: the setting goes with the migration that seeded it.
DELETE FROM settings WHERE key = 'gates.timeout_retries';
