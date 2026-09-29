-- 052_drift_rounds_max: how many review rounds running may fail because the base moved
-- before the supervisor stops sending the ticket back to fix and leaves it to the operator.
--
--   settings 'gates.drift_rounds_max'  a positive integer, 3. A round whose review gate failed
--              base_drift is a fix round (the fixer merges the base's tip and resubmits); a base that
--              keeps moving, or a fixer that never merges it, would loop paid fix sessions forever.
--              At this many consecutive drifted rounds core's reviewStep waits instead. A missing
--              row is a config error, never a silent default (§4), so the row moves with the code
--              that reads it. OR IGNORE keeps a value already set.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('gates.drift_rounds_max', '3', unixepoch() * 1000);
