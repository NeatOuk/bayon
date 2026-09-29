-- Reverts 031_project_timeline: the four indexes, then every audit row's project (the column has no
-- index, constraint or reference left once its index is gone, so DROP COLUMN takes it).
DROP INDEX human_requests_session_idx;
DROP INDEX sessions_agent_created_idx;
DROP INDEX ticket_events_ts_idx;
DROP INDEX audit_log_workspace_ts_idx;
ALTER TABLE audit_log DROP COLUMN workspace_id;
