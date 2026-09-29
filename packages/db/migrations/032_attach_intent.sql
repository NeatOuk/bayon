-- 032_attach_intent (M5): "take over after this step". The operator asks to attach to a
-- session mid-turn; the supervisor records the ask and attaches once the open run's terminal lands,
-- instead of stopping the agent in the middle of its turn (§12.5).
--
--   attach_intent_owner  the client token that becomes attach_lease_owner when the attach happens,
--               so the GUI tab that asked recognises its own lease by equality, as with an immediate
--               attach. Not a secret: an opaque correlation token, like the lease owner itself.
--   attach_intent_at     when it was asked (epoch ms). NULL: no takeover is pending.
--
-- The two are set together or not at all (the CHECK). Written by the supervisor only (§9.5): set
-- while the session is `running`, cleared by the attach edge, a cancel, a failed attempt, or the
-- session's last edge. The column is the record the GUI reads and a restart honours; the live
-- entry only caches it. NULL for every session already there: nothing is pending.
ALTER TABLE sessions ADD COLUMN attach_intent_owner TEXT;
ALTER TABLE sessions ADD COLUMN attach_intent_at INTEGER
  CHECK ((attach_intent_at IS NULL) = (attach_intent_owner IS NULL));
