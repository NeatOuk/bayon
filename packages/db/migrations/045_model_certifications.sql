-- 045_model_certifications: certification per (runner, executor, model) (§15, §9.8).
-- A certificate was earned on one model, the one the suite spawned; admission and the reviewer
-- pick now check the exact model a session would run, so the model is part of the key.
--   * runner_certifications: + model_id (models.id) and model (the model string the suite ran: a
--     pin like runner_version — a registration that renames the model behind the same id lapses
--     it). Primary key (runner_id, executor_id, model_id).
--   * conformance_probes: + model_id, the run's model (an audit row; nullable).
-- Existing rows keep the model they were earned on. Every stored certificate came from a suite that
-- spawned its kit's model, and every kit's model is its runner's `cheap` tier. SQL cannot read a
-- kit, so the rule reads the models rows the kit read: the runner's row ordered by
--   tier = 'cheap' DESC, active DESC, price_in_per_mtok ASC NULLS LAST, id ASC
-- first — the cheap-tier row when there is one (the active one first), else the cheapest, then the
-- lowest id: deterministic. A runner with no models row has no model a certificate could have been
-- earned on; its rows go. Both tables are rebuilt (SQLite cannot change a key) and created under
-- their own names, so the stored schema text is this file's.
ALTER TABLE runner_certifications RENAME TO runner_certifications_044;
ALTER TABLE conformance_probes RENAME TO conformance_probes_044;

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

CREATE TABLE conformance_probes (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  toolset_hash TEXT NOT NULL,
  runner_id TEXT NOT NULL REFERENCES runners(id),
  executor_id TEXT NOT NULL REFERENCES executors(id),
  model_id TEXT REFERENCES models(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TEMP TABLE earned_on AS
SELECT runner_id, id AS model_id, model FROM (
  SELECT m.runner_id, m.id, m.model,
         row_number() OVER (
           PARTITION BY m.runner_id
           ORDER BY m.tier = 'cheap' DESC, m.active DESC,
                    m.price_in_per_mtok IS NULL, m.price_in_per_mtok, m.id
         ) AS pick
  FROM models m
) WHERE pick = 1;

INSERT INTO runner_certifications (runner_id, executor_id, model_id, model, runner_version,
  suite_version, kit_hash, caps_hash, result_json, report_path, gate_eligible, passed_at,
  certified_at, decertified_at, decertified_reason)
SELECT c.runner_id, c.executor_id, e.model_id, e.model, c.runner_version, c.suite_version,
       c.kit_hash, c.caps_hash, c.result_json, c.report_path, c.gate_eligible, c.passed_at,
       c.certified_at, c.decertified_at, c.decertified_reason
FROM runner_certifications_044 c JOIN earned_on e ON e.runner_id = c.runner_id;

INSERT INTO conformance_probes (id, token_hash, toolset_hash, runner_id, executor_id, model_id,
  created_at, expires_at)
SELECT p.id, p.token_hash, p.toolset_hash, p.runner_id, p.executor_id, e.model_id, p.created_at,
       p.expires_at
FROM conformance_probes_044 p LEFT JOIN earned_on e ON e.runner_id = p.runner_id;

DROP TABLE earned_on;
DROP TABLE runner_certifications_044;
DROP TABLE conformance_probes_044;
