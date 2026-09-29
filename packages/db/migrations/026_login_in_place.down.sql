-- Reverts 026_login_in_place: the consent row goes, and with it every grant it held. A reader with
-- no row grants nothing, so the effect of the revert is that no login is used in place -- the safe
-- direction, and the operator's own files are left exactly as they are.
DELETE FROM settings WHERE key = 'runners.login_in_place';
