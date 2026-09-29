-- 052_drift_rounds_max down: the setting goes with the code that reads it. Without the row
-- `readGateSettings` no longer parses in this migration's code, which is why the row only ever
-- moves with it.
DELETE FROM settings WHERE key = 'gates.drift_rounds_max';
