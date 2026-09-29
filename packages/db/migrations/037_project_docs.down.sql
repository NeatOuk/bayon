-- Reverts 037_project_docs: every project's documentation source goes, and with it what doc_search
-- and doc_get can read -- both then refuse, naming the project's source as unset, which is what a
-- project with no source has always got. Nothing else is touched: no page, ticket or audit row here
-- came from a documentation site.
--
-- docs_spaces_json goes first: its CHECK names the other columns, and SQLite drops a column's own
-- CHECK with the column.
ALTER TABLE workspaces DROP COLUMN docs_spaces_json;
ALTER TABLE workspaces DROP COLUMN docs_email;
ALTER TABLE workspaces DROP COLUMN docs_url;
ALTER TABLE workspaces DROP COLUMN docs_kind;
