-- 007_gates (M3): the gate and finding lifecycles as CHECKs, the columns the gate engine
-- and the resolve/waive routes write, two indexes, and the M3 gate settings (M3 contracts):
--   * gates.state is running|passed|failed|waived. running → passed needs schema-valid evidence
--     and no open finding at gates.blocking_severities, else → failed; running|failed → waived
--     needs a reason. The next round is a new row at attempt n+1 (§10.3).
--   * findings.status is open|resolved|waived. Resolving records who and when (003's
--     resolved_by_run_id names the fixing run); waiving records who and why, shown forever.
--   * sessions.gate_id ties a reviewer session to its gate; sessions.fallback_from_runner_id is the
--     bound runner a fallback replaced (§9.8). runners.conformance_json is the last conformance
--     report's summary (§15).
--   No role_bindings rows: bindings are the operator's, set by frm, the GUI or a smoke (Invariant 1).
-- SQLite adds a CHECK only by rebuilding the table. foreign_keys is ON inside the runner's
-- transaction, so children go before parents: findings is copied aside and dropped, then gates;
-- both come back with their rows. The views that read them name them, so they need no rebuild. A
-- row whose state or status is outside the new sets fails the migration and nothing applies.

-- ─── gates and findings, rebuilt with their CHECKs ───────────────────────────
CREATE TABLE _findings_006 AS SELECT * FROM findings;
DROP TABLE findings;
CREATE TABLE _gates_006 AS SELECT * FROM gates;
DROP TABLE gates;

CREATE TABLE gates (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id),
  kind TEXT NOT NULL CHECK (kind IN ('plan_review','code_review','ce_review',
                                     'parity_check','qa_harness','human_qa')),
  required INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('running','passed','failed','waived')),
  attempt INTEGER NOT NULL DEFAULT 1,
  repo_id TEXT REFERENCES repos(id),        -- per-repo gates in multi-repo workspaces
  reviewer_session_id TEXT REFERENCES sessions(id),
  subject_kind TEXT NOT NULL, subject_ref TEXT NOT NULL,
  evidence_json TEXT,                       -- core's StoredGateEvidence
  findings_total INTEGER DEFAULT 0, findings_unresolved INTEGER DEFAULT 0,
  waived_by TEXT, waive_reason TEXT, started_at INTEGER, decided_at INTEGER,
  UNIQUE (ticket_id, kind, repo_id, attempt)
);
INSERT INTO gates (id, ticket_id, kind, required, state, attempt, repo_id, reviewer_session_id,
                   subject_kind, subject_ref, evidence_json, findings_total, findings_unresolved,
                   waived_by, waive_reason, started_at, decided_at)
  SELECT id, ticket_id, kind, required, state, attempt, repo_id, reviewer_session_id,
         subject_kind, subject_ref, evidence_json, findings_total, findings_unresolved,
         waived_by, waive_reason, started_at, decided_at
  FROM _gates_006;
-- 003's, dropped with the table: one gate per (ticket, kind, repo, attempt) even with no repo.
CREATE UNIQUE INDEX gates_attempt_idx ON gates(ticket_id, kind, coalesce(repo_id, ''), attempt);
-- The gate engine's sweep: running gates past their wall clock, and running gates at boot.
CREATE INDEX gates_state_idx ON gates(state, started_at);

CREATE TABLE findings (
  id TEXT PRIMARY KEY, gate_id TEXT NOT NULL REFERENCES gates(id),
  severity TEXT NOT NULL CHECK (severity IN ('blocker','major','minor','nit')),
  category TEXT, file TEXT, line INTEGER, summary TEXT NOT NULL, detail_md TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','waived')),
  resolved_by_run_id TEXT REFERENCES runs(id),
  resolution_note TEXT, created_at INTEGER NOT NULL,
  resolved_by TEXT, resolved_at INTEGER,    -- the actor who resolved it, and when
  waived_by TEXT, waive_reason TEXT         -- the actor who waived it, and why: shown forever
);
INSERT INTO findings (id, gate_id, severity, category, file, line, summary, detail_md, status,
                      resolved_by_run_id, resolution_note, created_at)
  SELECT id, gate_id, severity, category, file, line, summary, detail_md, status,
         resolved_by_run_id, resolution_note, created_at
  FROM _findings_006;
-- A gate's open findings: what blocks its transition, and findings_unresolved.
CREATE INDEX findings_gate_status_idx ON findings(gate_id, status);

DROP TABLE _gates_006;
DROP TABLE _findings_006;

-- ─── sessions and runners ────────────────────────────────────────────────────
ALTER TABLE sessions ADD COLUMN gate_id TEXT REFERENCES gates(id);
ALTER TABLE sessions ADD COLUMN fallback_from_runner_id TEXT REFERENCES runners(id);
ALTER TABLE runners ADD COLUMN conformance_json TEXT;

-- ─── settings (M3 contracts) ─────────────────────────────────────────────────
-- OR IGNORE: a key the operator already set keeps its value.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES
  ('gates.wall_clock_ms',       '900000',              unixepoch() * 1000),
  ('gates.blocking_severities', '["blocker","major"]', unixepoch() * 1000),
  ('gates.base_drift',          '"fail"',              unixepoch() * 1000),
  ('executors.untrusted_roles', '["investigator"]',    unixepoch() * 1000);
