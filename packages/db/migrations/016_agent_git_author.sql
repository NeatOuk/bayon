-- 016_agent_git_author (M4): the git identity agents commit as, one per install. The
-- supervisor sets it as GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL in every session's env,
-- so an agent's commit never carries the host's own user. `Name <email>` (core AgentGitAuthor); not
-- a secret. INSERT OR IGNORE as in 012 and 015: an operator's own value stays.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('agents.git_author', '"Bayon Agent <agent@bayon.invalid>"', unixepoch() * 1000);
