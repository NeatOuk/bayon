-- 049_context_compression: context compression, per project (spec M12; §4, §5.1, §8.9, §15).
--
--   * workspaces.context_compression: the project's switch, off by default. Written only by the API
--     (`PATCH /projects/:id` and `POST /projects`, audited), Invariant 5. A column CHECK naming only
--     itself, so the down drops it and 048's `workspaces` text comes back as it was.
--   * sessions.context_ruleset: the ruleset a session was spawned with, a pin like `model`; NULL is
--     off. An adopt resumes on it whatever the project's switch says by then.
--   * sessions.tokens_saved: the session's estimated saving (chars/4), summed from its spend rows;
--     NULL until a proxied run reports one, so a session never proxied never reads "saved 0".
--   * spend.tokens_saved: a run's estimated saving; NULL when the run was not proxied. The run's
--     `tokens_tool_result` (001) is filled from the same totals.
--   * runner_certifications: `compression` joins the key (runner_id, executor_id, model_id,
--     compression), so a project with compression on and one with it off are each admitted on their
--     own certificate of the same model. Every existing row is a compression-off one. The table is
--     rebuilt (SQLite cannot change a key) and created under its own name, so the stored schema text
--     is this file's. conformance_probes is keyed by id alone (one probe per suite run): untouched.
ALTER TABLE workspaces ADD COLUMN context_compression INTEGER NOT NULL DEFAULT 0
  CHECK (context_compression IN (0, 1));
ALTER TABLE sessions ADD COLUMN context_ruleset TEXT;
ALTER TABLE sessions ADD COLUMN tokens_saved INTEGER;
ALTER TABLE spend ADD COLUMN tokens_saved INTEGER;

ALTER TABLE runner_certifications RENAME TO runner_certifications_048;

CREATE TABLE runner_certifications (
  runner_id TEXT NOT NULL REFERENCES runners(id),
  executor_id TEXT NOT NULL REFERENCES executors(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  compression INTEGER NOT NULL DEFAULT 0 CHECK (compression IN (0, 1)),  -- earned with compression on
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
  PRIMARY KEY (runner_id, executor_id, model_id, compression),
  CHECK (decertified_at IS NULL OR (gate_eligible = 0 AND passed_at IS NULL))
);

INSERT INTO runner_certifications (runner_id, executor_id, model_id, compression, model,
  runner_version, suite_version, kit_hash, caps_hash, result_json, report_path, gate_eligible,
  passed_at, certified_at, decertified_at, decertified_reason)
SELECT runner_id, executor_id, model_id, 0, model, runner_version, suite_version, kit_hash,
       caps_hash, result_json, report_path, gate_eligible, passed_at, certified_at, decertified_at,
       decertified_reason
FROM runner_certifications_048;

DROP TABLE runner_certifications_048;
