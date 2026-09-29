-- 024_lint_check (M4): the `lint_check` gate kind, and the operator's switch for it.
--
-- Builders reach `request_review` with files that fail the repo's lint command, and the review round
-- is spent on something one command catches. The builder is told to lint in prose only (the `build`
-- template), and prompt text asks where the server decides (§10.3). A transition-law predicate
-- cannot carry it either: laws are pure and read rows, never a subprocess. So it is a gate, run as a
-- script job on `repos.lint_cmd` -- `parity_check`'s shape (020), which is why this migration looks
-- like 020 with 007's table rebuild in front of it.
--
-- SQLite adds a CHECK only by rebuilding the table, and `findings` references `gates`, so children
-- go first: findings is copied aside and dropped, then gates; both come back with their rows and
-- their indexes -- including 023's `round` column and `gates_round_idx`, which this rebuild must
-- carry or the laws lose the round marker an earlier change added.
--
-- `sessions.gate_id` (007) also references gates, and a session row cannot be copied aside: with
-- foreign_keys ON, DROP TABLE runs an implicit DELETE, and a reviewer session pointing at a gate
-- would make that an immediate violation and fail the whole migration on any fleet that has ever
-- run a gate. So the links are parked in a temp table, nulled, and put back after the rebuild --
-- the pointer is the same id either side, and `foreign_key_check` (which the runner runs after
-- every file) proves it. 007 needed none of this because it added the column afterwards.
--
-- The switch is seeded `false` and OR IGNORE keeps a value the operator already set. Off is the safe
-- state for the same asymmetric reason 020 gives: with the gate opening and required but no
-- `kind='util'` agent of the lint job seeded, every ticket stops in `code_review` behind a gate that
-- fails `no_reviewer` and that nobody can decide but by waiving. An operator turns it on once
-- `frm config apply` has seeded the lint checker and a repo declares a `lint_cmd` -- and until a
-- repo does, the gate's `when` fact is false and nothing opens or waits for it.

-- ─── gates and findings, rebuilt with the wider kind CHECK ───────────────────
CREATE TABLE _session_gates_023 AS
  SELECT id, gate_id FROM sessions WHERE gate_id IS NOT NULL;
UPDATE sessions SET gate_id = NULL WHERE gate_id IS NOT NULL;

CREATE TABLE _findings_023 AS SELECT * FROM findings;
DROP TABLE findings;
CREATE TABLE _gates_023 AS SELECT * FROM gates;
DROP TABLE gates;

CREATE TABLE gates (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id),
  kind TEXT NOT NULL CHECK (kind IN ('plan_review','code_review','ce_review',
                                     'parity_check','lint_check','qa_harness','human_qa')),
  required INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('running','passed','failed','waived')),
  attempt INTEGER NOT NULL DEFAULT 1,
  round INTEGER NOT NULL DEFAULT 1,         -- 023: the review round that opened it
  repo_id TEXT REFERENCES repos(id),        -- per-repo gates in multi-repo workspaces
  reviewer_session_id TEXT REFERENCES sessions(id),
  subject_kind TEXT NOT NULL, subject_ref TEXT NOT NULL,
  evidence_json TEXT,                       -- core's StoredGateEvidence
  findings_total INTEGER DEFAULT 0, findings_unresolved INTEGER DEFAULT 0,
  waived_by TEXT, waive_reason TEXT, started_at INTEGER, decided_at INTEGER,
  UNIQUE (ticket_id, kind, repo_id, attempt)
);
INSERT INTO gates (id, ticket_id, kind, required, state, attempt, round, repo_id,
                   reviewer_session_id, subject_kind, subject_ref, evidence_json, findings_total,
                   findings_unresolved, waived_by, waive_reason, started_at, decided_at)
  SELECT id, ticket_id, kind, required, state, attempt, round, repo_id,
         reviewer_session_id, subject_kind, subject_ref, evidence_json, findings_total,
         findings_unresolved, waived_by, waive_reason, started_at, decided_at
  FROM _gates_023;
-- 003's, dropped with the table: one gate per (ticket, kind, repo, attempt) even with no repo.
CREATE UNIQUE INDEX gates_attempt_idx ON gates(ticket_id, kind, coalesce(repo_id, ''), attempt);
-- The gate engine's sweep: running gates past their wall clock, and running gates at boot.
CREATE INDEX gates_state_idx ON gates(state, started_at);
-- 023's: the laws ask for a kind in the ticket's current round, the writers for its highest round.
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
  FROM _findings_023;
-- A gate's open findings: what blocks its transition, and findings_unresolved.
CREATE INDEX findings_gate_status_idx ON findings(gate_id, status);

DROP TABLE _gates_023;
DROP TABLE _findings_023;

UPDATE sessions
   SET gate_id = (SELECT p.gate_id FROM _session_gates_023 p WHERE p.id = sessions.id)
 WHERE id IN (SELECT id FROM _session_gates_023);
DROP TABLE _session_gates_023;

-- ─── the switch ──────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('gates.lint_check', 'false', unixepoch() * 1000);
