-- 027_project_local_roots (M4): the folders the GUI's New project form may take a repo
-- path from (spec §14), seeded at `[]` -- no folder, which is off: POST /projects then takes only an
-- https, ssh:// or scp-style url, as before. The row is a list of absolute paths.
--
-- Seeded rather than left absent so `frm settings get` shows the state as a value an operator can
-- read, as 026 does. It is a security control and shell-only: the GUI's PUT /settings whitelist
-- cannot reach it, and `frm settings set projects.local_roots <abs path>[,<abs path>] --yes` is its
-- one door.
--
-- INSERT OR IGNORE as in 012, 015, 016 and 026: an operator's own folders stay.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('projects.local_roots', '[]', unixepoch() * 1000);
