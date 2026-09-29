-- 029_project_paused (M5): one project's own hold, beside the fleet's `fleet.paused`.
-- While a workspace is paused nothing new starts in it -- admission queues its spawns and holds its
-- sessions' next turns (`project_paused`), and its orchestrator does not pulse -- and every other
-- project runs on. What is in flight finishes.
--
-- A column, not a settings key: settings is a fixed allowlist whose missing row admission reads as
-- a config error, and a column is read with its workspace. 0 for every workspace already there:
-- nothing is paused by the migration. Written only by the API's POST /projects/:id/pause|resume,
-- each change audited.
ALTER TABLE workspaces ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));
