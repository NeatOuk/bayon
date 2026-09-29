-- Reverts 036_qa_harness: every project's QA configuration goes, and with it the gate `pass_review`
-- would open; `qa_passed` is the operator's override with a note again. The runs go with the table.
-- The gates and findings a QA run left stay, as any decided gate does.
--
-- qa_junit goes first: its CHECK names the other columns, and SQLite drops a column's own CHECK with
-- the column.
DROP INDEX qa_runs_ticket_idx;
DROP TABLE qa_runs;

ALTER TABLE workspaces DROP COLUMN qa_junit;
ALTER TABLE workspaces DROP COLUMN qa_reports_json;
ALTER TABLE workspaces DROP COLUMN qa_secrets_json;
ALTER TABLE workspaces DROP COLUMN qa_timeout_ms;
ALTER TABLE workspaces DROP COLUMN qa_cmd;
ALTER TABLE workspaces DROP COLUMN qa_mode;
