-- 028_tickets_workspace_index (M4): an index on tickets(workspace_id, status).
--
-- A project's tickets are read by project on every hot path since an earlier change and an earlier change: the
-- board's filter (listTickets), a project's orchestrator's ticket_search, its pulse's no-op check
-- (hasPulseWork's `ticket_id IN (SELECT id FROM tickets WHERE workspace_id = ?)`) and every section
-- of its context pack. With no index on workspace_id each of those scans tickets.
--
-- (workspace_id, status), not (workspace_id) alone: the pack's counts and in-flight list filter or
-- group a project's tickets by status, so the second column saves the lookup back to the table.
CREATE INDEX tickets_workspace_status_idx ON tickets(workspace_id, status);
