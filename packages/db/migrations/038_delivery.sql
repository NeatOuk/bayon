-- 038_delivery (M7.7): a project's delivery, and the record of what was delivered.
--
-- Until now a ticket's finished work ended on a local `frm/…` branch, in a worktree and in the
-- repo's bare mirror, and went no further: `tickets.pr_url` has had no writer since 003. This gives
-- a project two switches and one table, and the supervisor a job that acts on them.
--
--   workspaces.delivery_mode  'none' (every project already here), 'push' or 'pull_request'.
--             'push' puts each touched repo's branch on that repo's own recorded origin;
--             'pull_request' also opens a request per pushed branch on that remote's forge.
--   workspaces.delivery_when  'review_passed' (the default) or 'done': the moment a ticket's work
--             is delivered, read as a SET of statuses by the sweep, not as an edge.
--
-- There is deliberately no base-branch column. A pull request's base is that repo's own
-- `repos.default_base_branch`, which a submodule project may spell differently per submodule; a
-- second copy on the workspace could only ever disagree with it.
--
-- The CHECK is on the last column added, as 032's, 033's and 036's are: SQLite drops a column's own
-- CHECK with the column, so the down migration can take them away in the reverse order.
ALTER TABLE workspaces ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'none';
ALTER TABLE workspaces ADD COLUMN delivery_when TEXT NOT NULL DEFAULT 'review_passed'
  CHECK (delivery_mode IN ('none','push','pull_request')
         AND delivery_when IN ('review_passed','done'));

-- The supervisor's table (§9.5 amendment, Invariant 5). One row per (ticket, repo), replaced in
-- place: the unique index is what makes the job idempotent at the database rather than in a comment.
-- A re-run reads the row and, when it already carries this branch's head — and, in 'pull_request'
-- mode, a pull request — has nothing left to do.
--
-- `remote_host` is the remote's HOST and never its URL: a URL can carry userinfo, and §14 keeps a
-- credential out of the database in every form. `error` is scrubbed and capped by its writer.
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
);
CREATE UNIQUE INDEX deliveries_ticket_repo_idx ON deliveries(ticket_id, repo_id);
