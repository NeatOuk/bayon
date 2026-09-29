-- 020_parity_check (M4): the operator's switch for the `parity_check` gate.
--
-- §10.3 makes parity_check required when a workspace's kind is not 'single'. Turning that on is one
-- setting rather than a deploy, because the failure mode is asymmetric: with the gate opening and
-- required but no `kind='util'` agent of the parity job seeded, every multi-repo ticket stops in
-- code_review behind a gate that fails `no_reviewer` and that nobody can decide but by waiving.
--
-- Off is the safe state and the default: no review round opens the gate, and `pass_review` does not
-- ask for it, so a fleet upgrading to this version behaves exactly as it did. An operator turns it
-- on once the parity checker's rows exist (`frm config apply`, tools/frm/src/smoke/parity-config.ts).
-- One switch decides both halves, so open and required can never disagree.
--
-- OR IGNORE: a value the operator already set is kept.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('gates.parity_check', 'false', unixepoch() * 1000);
