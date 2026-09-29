-- Reverts 003_work. Drops the work tables and all their data: dev and test only (the CLI wants
-- --yes). The triggers on tickets go first (tickets stays), then the views, the token index, the
-- FTS tables, and the tables children before parents, since with foreign_keys=ON each DROP
-- deletes its rows first.
DROP TRIGGER tickets_fts_insert;
DROP TRIGGER tickets_fts_delete;
DROP TRIGGER tickets_fts_update;
DROP TRIGGER knowledge_fts_insert;
DROP TRIGGER knowledge_fts_delete;
DROP TRIGGER knowledge_fts_update;
DROP TRIGGER handoffs_fts_insert;
DROP TRIGGER handoffs_fts_delete;
DROP TRIGGER handoffs_fts_update;
DROP VIEW v_ticket_economics;
DROP VIEW v_needs_attention;
DROP INDEX sessions_mcp_token_idx;
DROP TABLE tickets_fts;
DROP TABLE knowledge_fts;
DROP TABLE handoffs_fts;
DROP TABLE findings;
DROP TABLE gates;
DROP TABLE ticket_repos;
DROP TABLE ticket_events;
DROP TABLE ticket_links;
DROP TABLE ticket_exports;
DROP TABLE handoffs;
DROP TABLE messages;
DROP TABLE human_requests;
DROP TABLE approvals;
DROP TABLE knowledge;
DROP TABLE role_bindings;
