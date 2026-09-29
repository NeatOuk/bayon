-- 040_merge_close down: back to 039's schema, `deliveries` byte for byte as 039 stored it (038's
-- CREATE text with 039's `remote_url` appended by ALTER TABLE ADD COLUMN), keeping every row.
--
-- A `merged` or `closed` row cannot stay: the restored CHECK forbids both. It goes back to
-- `pr_open`, which is what it was before the sweep recorded its end — the request still exists on
-- the forge, and nothing on any remote is touched. Who merged it, and when, is lost with the
-- columns; the ticket's timeline keeps both.
UPDATE deliveries SET state = 'pr_open' WHERE state IN ('merged','closed');

ALTER TABLE workspaces DROP COLUMN close_on_merge;

CREATE TABLE _deliveries_040 AS SELECT * FROM deliveries;
DROP TABLE deliveries;
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  -- The ref that was delivered, as the worktree recorded it.
  branch TEXT NOT NULL,
  -- The commit now on the remote; NULL while nothing has been pushed.
  head_sha TEXT,
  remote_host TEXT,
  state TEXT NOT NULL CHECK (state IN ('pushed','pr_open','failed')),
  pr_url TEXT,
  pr_number INTEGER,
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
, remote_url TEXT);
INSERT INTO deliveries (id, ticket_id, repo_id, branch, head_sha, remote_host, state, pr_url,
                        pr_number, error, started_at, ended_at, remote_url)
  SELECT id, ticket_id, repo_id, branch, head_sha, remote_host, state, pr_url,
         pr_number, error, started_at, ended_at, remote_url
  FROM _deliveries_040;
DROP TABLE _deliveries_040;
CREATE UNIQUE INDEX deliveries_ticket_repo_idx ON deliveries(ticket_id, repo_id);
