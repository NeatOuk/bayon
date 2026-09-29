-- Reverts 014_watchdog: the index, then the column.
DROP INDEX human_requests_dedupe_idx;
ALTER TABLE human_requests DROP COLUMN dedupe_key;
