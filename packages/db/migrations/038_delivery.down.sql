-- Reverts 038_delivery: every project's delivery configuration goes, and the record of what was
-- delivered with it. Nothing on any remote is touched — a branch already pushed stays pushed and a
-- pull request already open stays open, which is why the down migration is safe to run at all.
--
-- The `tickets.pr_url` and `ticket_links` rows a delivery wrote are left where they are, as any
-- recorded fact is: they name pull requests that exist.
--
-- delivery_when goes first: its CHECK names delivery_mode, and SQLite drops a column's own CHECK
-- with the column.
DROP INDEX deliveries_ticket_repo_idx;
DROP TABLE deliveries;

ALTER TABLE workspaces DROP COLUMN delivery_when;
ALTER TABLE workspaces DROP COLUMN delivery_mode;
