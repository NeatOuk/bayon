-- 010_executor_health_detail down: the column goes; health and health_checked_at stay.
ALTER TABLE executors DROP COLUMN health_detail;
