-- Reverts 007_gates to 006's schema byte for byte, keeping the rows: the M3 settings rows go, the
-- added columns are dropped, and gates and findings are rebuilt children first, as in the up, with
-- 003's DDL verbatim (no state or status CHECK). findings lose resolved_by, resolved_at, waived_by
-- and waive_reason; their status text stays.
DELETE FROM settings WHERE key IN (
  'gates.wall_clock_ms', 'gates.blocking_severities', 'gates.base_drift', 'executors.untrusted_roles'
);
ALTER TABLE runners DROP COLUMN conformance_json;
ALTER TABLE sessions DROP COLUMN fallback_from_runner_id;
ALTER TABLE sessions DROP COLUMN gate_id;

CREATE TABLE _findings_007 AS SELECT * FROM findings;
DROP TABLE findings;
CREATE TABLE _gates_007 AS SELECT * FROM gates;
DROP TABLE gates;

CREATE TABLE gates (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id),
  kind TEXT NOT NULL CHECK (kind IN ('plan_review','code_review','ce_review',
                                     'parity_check','qa_harness','human_qa')),
  required INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  repo_id TEXT REFERENCES repos(id),        -- per-repo gates in multi-repo workspaces
  reviewer_session_id TEXT REFERENCES sessions(id),
  subject_kind TEXT NOT NULL, subject_ref TEXT NOT NULL,
  evidence_json TEXT,                       -- cmd, exit code, duration, cost, artifact paths
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
  FROM _gates_007;
CREATE UNIQUE INDEX gates_attempt_idx ON gates(ticket_id, kind, coalesce(repo_id, ''), attempt);

CREATE TABLE findings (
  id TEXT PRIMARY KEY, gate_id TEXT NOT NULL REFERENCES gates(id),
  severity TEXT NOT NULL CHECK (severity IN ('blocker','major','minor','nit')),
  category TEXT, file TEXT, line INTEGER, summary TEXT NOT NULL, detail_md TEXT,
  status TEXT NOT NULL DEFAULT 'open', resolved_by_run_id TEXT REFERENCES runs(id),
  resolution_note TEXT, created_at INTEGER NOT NULL
);
INSERT INTO findings (id, gate_id, severity, category, file, line, summary, detail_md, status,
                      resolved_by_run_id, resolution_note, created_at)
  SELECT id, gate_id, severity, category, file, line, summary, detail_md, status,
         resolved_by_run_id, resolution_note, created_at
  FROM _findings_007;

DROP TABLE _gates_007;
DROP TABLE _findings_007;
