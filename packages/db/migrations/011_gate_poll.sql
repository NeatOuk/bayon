-- 011_gate_poll (M3): how often the gate engine looks for gates that stopped running
-- under a live reviewer (superseded or waived) and for gates past their deadline (-- §8, review M2). A setting, not a constant (§4: config over code). The API's session.stop in the
-- supersede and waive writers usually gets there first; the poll is the backstop.
-- OR IGNORE: a value the operator already set is kept.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('gates.supersede_poll_ms', '5000', unixepoch() * 1000);
