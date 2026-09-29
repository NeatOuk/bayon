-- Reverts 001_spine. Drops every table and all their data: dev and test only (the CLI wants --yes).
-- Children go before parents, because with foreign_keys=ON each DROP deletes its rows first.
-- tickets.owner_session_id and sessions.ticket_id form a cycle, so the owner is cleared first.
DROP VIEW v_fleet;
UPDATE tickets SET owner_session_id = NULL WHERE owner_session_id IS NOT NULL;
DROP TABLE events;
DROP TABLE spend;
DROP TABLE runs;
DROP TABLE sessions;
DROP TABLE tickets;
DROP TABLE worktrees;
DROP TABLE workspace_repos;
DROP TABLE agents;
DROP TABLE workspaces;
DROP TABLE repos;
DROP TABLE profiles;
DROP TABLE missions;
DROP TABLE prompt_templates;
DROP TABLE run_classes;
DROP TABLE models;
DROP TABLE executors;
DROP TABLE runners;
DROP TABLE commands;
DROP TABLE supervisor_state;
DROP TABLE settings;
DROP TABLE audit_log;
