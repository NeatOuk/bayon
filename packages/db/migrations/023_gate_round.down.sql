-- 023_gate_round down: the round marker goes, and with it the laws' ability to tell this round's
-- gate from an earlier one. Gates and their attempts are untouched; the code that reads `round`
-- only ever moves with this migration.
DROP INDEX IF EXISTS gates_round_idx;
ALTER TABLE gates DROP COLUMN round;
