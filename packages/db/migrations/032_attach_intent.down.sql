-- Reverts 032_attach_intent: both columns go, and with them any pending takeover -- the session
-- simply carries on automated, as it would after a cancel. attach_intent_at goes first: its CHECK
-- names attach_intent_owner, and SQLite drops a column's own CHECK with the column.
ALTER TABLE sessions DROP COLUMN attach_intent_at;
ALTER TABLE sessions DROP COLUMN attach_intent_owner;
