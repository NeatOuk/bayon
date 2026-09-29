-- 046_operator_models down: 045's models table. Operator rows stay as plain rows; the boot of the
-- code before 046 deactivates every row of a runner and re-activates its registered ones.
ALTER TABLE models DROP COLUMN settings_json;
ALTER TABLE models DROP COLUMN source;
