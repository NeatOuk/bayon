-- Reverts 029_project_paused: the column goes, and with it every project's pause -- the permissive
-- direction, so the fleet's own `fleet.paused` is then the only hold. Its CHECK is the column's
-- own, so SQLite drops the two together (as 015's kept_reason).
ALTER TABLE workspaces DROP COLUMN paused;
