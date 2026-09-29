-- 020_parity_check down: the setting goes; nothing else changes. Without the row the gate settings
-- no longer parse, so the laws report their facts unavailable rather than silently defaulting --
-- which is why this migration only ever moves with the code that reads it.
DELETE FROM settings WHERE key = 'gates.parity_check';
