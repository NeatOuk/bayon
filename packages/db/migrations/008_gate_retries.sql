-- 008_gate_retries (M3): how many times decideGate reopens a gate that timed out or met a
-- supervisor restart, in the same transaction. A setting,
-- not a constant (§4: config over code); readGateSettings refuses a database without it.
-- OR IGNORE: a value the operator already set is kept.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('gates.timeout_retries', '1', unixepoch() * 1000);
