-- 026_login_in_place (M4): the operator's consent to a login used in place (spec §14),
-- seeded at `{}` -- granted to nobody, which is off. The row is a map of runner id to the absolute
-- path of the login file that runner may read and write in place, instead of a copy of a rotating
-- credential in the secret store. It holds paths, never a credential.
--
-- Seeded rather than left absent so `frm settings get` shows the consent state as a value an
-- operator can read, the way the other governed settings are shown (007, 012, 016). It is a
-- security control and shell-only: the GUI's PUT /settings whitelist cannot reach it, and
-- `frm settings set runners.login_in_place <runner-id>=<path> --yes` is its one door.
--
-- INSERT OR IGNORE as in 012, 015 and 016: an operator's own grants stay.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('runners.login_in_place', '{}', unixepoch() * 1000);
