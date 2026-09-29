-- Reverts 045_model_certifications to 044's schema, byte for byte: both tables rebuilt without
-- model_id/model and keyed (runner_id, executor_id) again. Where a pair holds several models' rows,
-- the one kept is the row 045's mapping rule would have chosen (the runner's cheap tier, active
-- first, then the cheapest, then the lowest id) when there is one, else the most recently
-- certified, then the lowest model id: the one certificate 044's single row could have meant.
ALTER TABLE runner_certifications RENAME TO runner_certifications_045;
ALTER TABLE conformance_probes RENAME TO conformance_probes_045;

CREATE TABLE runner_certifications (
  runner_id TEXT NOT NULL REFERENCES runners(id),
  executor_id TEXT NOT NULL REFERENCES executors(id),
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
  PRIMARY KEY (runner_id, executor_id),
  CHECK (decertified_at IS NULL OR (gate_eligible = 0 AND passed_at IS NULL))
);

CREATE TABLE conformance_probes (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  toolset_hash TEXT NOT NULL,
  runner_id TEXT NOT NULL REFERENCES runners(id),
  executor_id TEXT NOT NULL REFERENCES executors(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

INSERT INTO runner_certifications (runner_id, executor_id, runner_version, suite_version, kit_hash,
  caps_hash, result_json, report_path, gate_eligible, passed_at, certified_at, decertified_at,
  decertified_reason)
SELECT runner_id, executor_id, runner_version, suite_version, kit_hash, caps_hash, result_json,
       report_path, gate_eligible, passed_at, certified_at, decertified_at, decertified_reason
FROM (
  SELECT c.*,
         row_number() OVER (
           PARTITION BY c.runner_id, c.executor_id
           ORDER BY c.model_id IS (
                      SELECT m.id FROM models m WHERE m.runner_id = c.runner_id
                      ORDER BY m.tier = 'cheap' DESC, m.active DESC,
                               m.price_in_per_mtok IS NULL, m.price_in_per_mtok, m.id
                      LIMIT 1
                    ) DESC,
                    c.certified_at DESC, c.model_id
         ) AS pick
  FROM runner_certifications_045 c
) WHERE pick = 1;

INSERT INTO conformance_probes (id, token_hash, toolset_hash, runner_id, executor_id, created_at,
  expires_at)
SELECT id, token_hash, toolset_hash, runner_id, executor_id, created_at, expires_at
FROM conformance_probes_045;

DROP TABLE runner_certifications_045;
DROP TABLE conformance_probes_045;
