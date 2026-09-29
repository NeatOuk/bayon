-- 011_gate_poll down: the setting goes; nothing else changes.
DELETE FROM settings WHERE key = 'gates.supersede_poll_ms';
