-- Reverts 028_tickets_workspace_index: a project's ticket reads go back to scanning tickets.
DROP INDEX tickets_workspace_status_idx;
