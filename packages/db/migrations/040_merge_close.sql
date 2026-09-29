-- 040_merge_close (M8.2): a pull request's end, and the switch that lets a merge close
-- the ticket.
--
-- 038 records a pull request as `pr_open` and nothing more, so a merge on the forge was invisible
-- to Bayon and the operator had to say "done" a second time. The supervisor's pull-request sweep
-- now polls each open request; these are the states and columns it records into.
--
--   deliveries.state      gains `merged` and `closed` (closed without merging).
--   deliveries.merged_at  epoch-millis, as the forge reported it; NULL until merged.
--   deliveries.merged_by  the forge login that merged it: a name, never a credential (§14).
--   workspaces.close_on_merge  1 (the default, every project here): the ticket goes to `done` when
--             all of its pull requests have merged. 0: the merge is recorded and the ticket stays.
--
-- SQLite adds a CHECK value only by rebuilding the table. Nothing references `deliveries`, so it is
-- copied aside, dropped and recreated with every row, its foreign keys and its unique index.
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
  state TEXT NOT NULL CHECK (state IN ('pushed','pr_open','merged','closed','failed')),
  pr_url TEXT,
  pr_number INTEGER,
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  -- 039: the target pushed to, credentials removed; NULL on rows from before 039.
  remote_url TEXT,
  -- 040: when the pull request merged, and who merged it (a forge login).
  merged_at INTEGER,
  merged_by TEXT
);
INSERT INTO deliveries (id, ticket_id, repo_id, branch, head_sha, remote_host, state, pr_url,
                        pr_number, error, started_at, ended_at, remote_url)
  SELECT id, ticket_id, repo_id, branch, head_sha, remote_host, state, pr_url,
         pr_number, error, started_at, ended_at, remote_url
  FROM _deliveries_040;
DROP TABLE _deliveries_040;
CREATE UNIQUE INDEX deliveries_ticket_repo_idx ON deliveries(ticket_id, repo_id);
-- The pull-request sweep's candidates: the tickets with a request still open.
CREATE INDEX deliveries_state_idx ON deliveries(state, ticket_id);

ALTER TABLE workspaces ADD COLUMN close_on_merge INTEGER NOT NULL DEFAULT 1
  CHECK (close_on_merge IN (0,1));
