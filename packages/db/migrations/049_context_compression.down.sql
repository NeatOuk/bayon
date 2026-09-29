-- 049_context_compression down: 048's schema, byte for byte. runner_certifications is rebuilt to
-- 045's text (048 still had it) and keeps only its compression-off rows: a compression-on
-- certificate has no place in the (runner, executor, model) key, and the sessions it admitted run
-- uncompressed after the down anyway. Then the added columns go, last first; the project's switch
-- carries only its own CHECK, which SQLite drops with it.
ALTER TABLE runner_certifications RENAME TO runner_certifications_049;

CREATE TABLE runner_certifications (
  runner_id TEXT NOT NULL REFERENCES runners(id),
  executor_id TEXT NOT NULL REFERENCES executors(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  model TEXT NOT NULL,                       -- the model string the suite spawned: a pin
  runner_version TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  kit_hash TEXT NOT NULL,
  caps_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,                 -- core ConformanceResult, as certify() returned it
  report_path TEXT,
  gate_eligible INTEGER NOT NULL DEFAULT 0 CHECK (gate_eligible IN (0, 1)),
  passed_at INTEGER,                         -- unattended allowed: tests 9, 10 and 14 passed
  certified_at INTEGER NOT NULL,
  decertified_at INTEGER,
  decertified_reason TEXT,
  PRIMARY KEY (runner_id, executor_id, model_id),
  CHECK (decertified_at IS NULL OR (gate_eligible = 0 AND passed_at IS NULL))
);

INSERT INTO runner_certifications (runner_id, executor_id, model_id, model, runner_version,
  suite_version, kit_hash, caps_hash, result_json, report_path, gate_eligible, passed_at,
  certified_at, decertified_at, decertified_reason)
SELECT runner_id, executor_id, model_id, model, runner_version, suite_version, kit_hash, caps_hash,
       result_json, report_path, gate_eligible, passed_at, certified_at, decertified_at,
       decertified_reason
FROM runner_certifications_049
WHERE compression = 0;

DROP TABLE runner_certifications_049;

ALTER TABLE spend DROP COLUMN tokens_saved;
ALTER TABLE sessions DROP COLUMN tokens_saved;
ALTER TABLE sessions DROP COLUMN context_ruleset;
ALTER TABLE workspaces DROP COLUMN context_compression;
