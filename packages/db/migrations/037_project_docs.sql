-- 037_project_docs (M7.6): where a project's documentation lives, so its agents can read
-- the pages its tickets point at.
--
-- A ticket's "Done when" is often a link into a documentation site. An agent's only door is Bayon's
-- own /mcp, so until now it worked from the summary. Two read-only tools (doc_search, doc_get) read
-- that site on the session's behalf; these four columns are what they read it from.
--
--   workspaces.docs_kind        'none' (every project already here) or 'confluence'.
--              NOT NULL with a default because SQLite needs one to add a NOT NULL column, and
--              because "no column" and "this project has no documentation source" are the same
--              statement.
--   workspaces.docs_url         the site, `https://<name>.atlassian.net` exactly -- the same origin
--              pin 033 holds the Jira source to (core `isJiraSite`), and for the same reason: the
--              operator's Atlassian token is sent to it, and the value arrives over REST from any
--              page on the LAN holding the operator's bearer.
--   workspaces.docs_email       the Atlassian account the token belongs to (the Basic auth user).
--   workspaces.docs_spaces_json the space keys an agent may read, `[A-Z0-9_]{1,50}`, JSON array.
--              An empty list means any space the account can read.
--
-- No token column. The credential is the one 033's mirror already reads at call time from the host
-- secret store (JIRA_API_TOKEN): one Atlassian account, one token, two read-only surfaces. A second
-- secret would be a second thing to rotate and a second thing to leak (§14, Invariant 11).
--
-- The CHECK is on the last column added, as 032's, 033's and 036's are: a source of kind
-- 'confluence' must have a site and an account, because a reader with neither could only ever fail.
-- SQLite drops a column's own CHECK with the column, so the down migration drops this one first.
--
-- 'none' for every workspace already there: nothing new is readable by the migration.
ALTER TABLE workspaces ADD COLUMN docs_kind TEXT NOT NULL DEFAULT 'none';
ALTER TABLE workspaces ADD COLUMN docs_url TEXT;
ALTER TABLE workspaces ADD COLUMN docs_email TEXT;
ALTER TABLE workspaces ADD COLUMN docs_spaces_json TEXT
  CHECK (docs_kind IN ('none','confluence')
         AND (docs_kind <> 'confluence'
              OR (docs_url IS NOT NULL AND docs_email IS NOT NULL)));
