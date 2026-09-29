-- 053_private_repo_hosts: the loopback and private-network hosts a project's repo may be
-- read from (spec §14), seeded at `[]` -- none. A repo URL makes the supervisor connect from this
-- machine, and New project can be reached from the LAN, so a URL on this machine or its private
-- network is refused unless its host is listed here. Link-local and cloud metadata addresses are
-- refused whatever this holds. A security control and shell-only, as 027's local roots:
-- `frm settings set projects.private_repo_hosts <host>[,<host>] --yes` is its one door, audited.
--
-- INSERT OR IGNORE as in 026 and 027: an operator's own list stays.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('projects.private_repo_hosts', '[]', unixepoch() * 1000);
