-- Reverts 016_agent_git_author: the agents' git identity goes; sessions then commit as the host.
DELETE FROM settings WHERE key = 'agents.git_author';
