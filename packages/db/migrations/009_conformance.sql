-- 009_conformance (M3): conformance certification per (runner, executor) (§15; design
--, and the probe tokens the API's /mcp serves conformance_echo to (test 11).
--   * runner_certifications: one row per pair, written only from a certifiable result (core
--     certify()), so an incomplete run never replaces or clears one. gate_eligible and passed_at
--     (= unattended allowed) are certify()'s. A change of runner version, caps, kit_hash or
--     suite_version decertifies the pair: its flags clear, decertified_* say why, the result stays.
--   * runners.conformance_* and gate_eligible become a roll-up of the runner's live pairs:
--     certified on at least one executor. Nothing backs the values they held before, so they clear.
--   * conformance_probes: a suite's probe token (its hash) and tool set, until expires_at. The
--     API's /mcp serves it conformance_echo and nothing else.
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

UPDATE runners
SET gate_eligible = 0, conformance_version = NULL, conformance_passed_at = NULL,
    conformance_report_path = NULL, conformance_json = NULL;
