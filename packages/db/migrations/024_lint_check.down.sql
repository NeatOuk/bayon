-- 024_lint_check down: back to 023's schema, byte for byte, keeping every row the narrower CHECK
-- can still hold. Byte for byte is meant literally and is asserted: `sqlite_schema.sql` for both
-- rebuilt tables comes back identical to a chain that only ever ran up to 023, comments and column
-- order included (migrate-024.test.ts). That is why `round` sits after `decided_at` on one line
-- here rather than where it reads best: 023 added it with ALTER TABLE ADD COLUMN, which appends
-- the column to the end of the stored text and to the end of the table, and a rebuild that put it
-- at position 7 would leave a database no `SELECT *` or `pragma_table_info` could tell from 023's
-- but no diff would call equal.
--
-- It cannot hold all of them. A `lint_check` gate is a row of a kind the restored CHECK forbids, so
-- it goes, and its findings with it (children first, foreign_keys is ON inside the runner's
-- transaction). That is destructive and deliberate: the alternative is a down migration that aborts
-- on any fleet that ever ran the gate, which is no way back at all. The code that opens these gates
-- only ever moves with this migration, so a down with rows to delete means a rollback past the
-- feature -- waive or decide them first if their evidence is wanted.
--
-- The setting goes too. Without the row `readGateSettings` no longer parses, so the laws report
-- their facts unavailable rather than silently defaulting -- which is why the row moves with the
-- code that reads it.
--
-- `sessions.gate_id` is parked and restored around the rebuild for the reason the up file gives: a
-- session pointing at a gate makes DROP TABLE's implicit DELETE an immediate violation. A reviewer
-- session of a deleted `lint_check` gate loses its link here, since the gate it named is gone.
UPDATE sessions SET gate_id = NULL
 WHERE gate_id IN (SELECT id FROM gates WHERE kind = 'lint_check');
DELETE FROM findings WHERE gate_id IN (SELECT id FROM gates WHERE kind = 'lint_check');
DELETE FROM gates WHERE kind = 'lint_check';
DELETE FROM settings WHERE key = 'gates.lint_check';

CREATE TABLE _session_gates_024 AS
  SELECT id, gate_id FROM sessions WHERE gate_id IS NOT NULL;
UPDATE sessions SET gate_id = NULL WHERE gate_id IS NOT NULL;

CREATE TABLE _findings_024 AS SELECT * FROM findings;
DROP TABLE findings;
CREATE TABLE _gates_024 AS SELECT * FROM gates;
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
  waived_by TEXT, waive_reason TEXT, started_at INTEGER, decided_at INTEGER, round INTEGER NOT NULL DEFAULT 1,
  UNIQUE (ticket_id, kind, repo_id, attempt)
);
INSERT INTO gates (id, ticket_id, kind, required, state, attempt, round, repo_id,
                   reviewer_session_id, subject_kind, subject_ref, evidence_json, findings_total,
                   findings_unresolved, waived_by, waive_reason, started_at, decided_at)
  SELECT id, ticket_id, kind, required, state, attempt, round, repo_id,
         reviewer_session_id, subject_kind, subject_ref, evidence_json, findings_total,
         findings_unresolved, waived_by, waive_reason, started_at, decided_at
  FROM _gates_024;
CREATE UNIQUE INDEX gates_attempt_idx ON gates(ticket_id, kind, coalesce(repo_id, ''), attempt);
CREATE INDEX gates_state_idx ON gates(state, started_at);
CREATE INDEX gates_round_idx ON gates(ticket_id, round);

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
                      resolved_by_run_id, resolution_note, created_at,
                      resolved_by, resolved_at, waived_by, waive_reason)
  SELECT id, gate_id, severity, category, file, line, summary, detail_md, status,
         resolved_by_run_id, resolution_note, created_at,
         resolved_by, resolved_at, waived_by, waive_reason
  FROM _findings_024;
CREATE INDEX findings_gate_status_idx ON findings(gate_id, status);

DROP TABLE _gates_024;
DROP TABLE _findings_024;

UPDATE sessions
   SET gate_id = (SELECT p.gate_id FROM _session_gates_024 p WHERE p.id = sessions.id)
 WHERE id IN (SELECT id FROM _session_gates_024);
DROP TABLE _session_gates_024;
