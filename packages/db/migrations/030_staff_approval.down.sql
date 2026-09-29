-- Reverts 030_staff_approval: the index, what each proposal proposed, and every project's switch go
-- (the switch's CHECK is the column's own, so SQLite drops the two together, as 029's `paused`).
-- Rows of kind `staff_approval` stay, as any request does; without their proposal an open one can
-- only be answered as text, which staffs nothing -- the permissive direction is the operator's own
-- staffing, which never needed approval.
DROP INDEX human_requests_ticket_status_idx;
ALTER TABLE human_requests DROP COLUMN proposal_json;
ALTER TABLE workspaces DROP COLUMN staff_approval;
