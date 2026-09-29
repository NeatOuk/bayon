-- Reverts 053_private_repo_hosts: the row goes, and with it every private host it allowed. A reader
-- with no row allows none -- the safe direction.
DELETE FROM settings WHERE key = 'projects.private_repo_hosts';
