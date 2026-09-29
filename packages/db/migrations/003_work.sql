-- 003_work: the §4 work tables (FOR-11), their full-text search, and the v_needs_attention and
-- v_ticket_economics views (§4.1). tickets, missions and commands are in 001. The DDL is §4
-- verbatim except where a comment says otherwise. The M1 amendments it applies:
--   3  No events_fts (its ingest cost). tickets_fts indexes tickets as external content with
--      rowid = num; triggers keep it in step, and the closing 'rebuild' indexes the tickets
--      already here. knowledge_fts and handoffs_fts keep their own copy, keyed by ref (the row
--      id): a TEXT key cannot be an FTS rowid, and an implicit rowid may change on VACUUM.
--   4  v_needs_attention has no qa_runs or budgets arm until those tables exist, and gains
--      export_failed. Its findings_open arm is DISTINCT: one row per gate, not per finding.
--   5  ticket_exports is the supervisor's: the exporter runs as a script runner.
--   9  v_ticket_economics derives cost_usd, review_rounds and handoff_count (and cost_wasted_usd
--      alike) from spend, gates and handoffs. Nothing writes those tickets columns.
-- And sessions.mcp_token_hash becomes unique: a token names exactly one session (§11.1). The
-- index fails on a database where two sessions share a hash; M0 minted each from a random token.

-- ─── tickets ─────────────────────────────────────────────────────────────────
CREATE TABLE ticket_repos (
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  PRIMARY KEY (ticket_id, repo_id)
);

CREATE TABLE ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id), ts INTEGER NOT NULL,
  actor_kind TEXT NOT NULL, actor_id TEXT, kind TEXT NOT NULL,
  from_status TEXT, to_status TEXT, reason TEXT, payload_json TEXT
);
CREATE INDEX ticket_events_idx ON ticket_events(ticket_id, id);

CREATE TABLE ticket_links (
  ticket_id TEXT NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL,
  url TEXT, target_ticket_id TEXT REFERENCES tickets(id), created_at INTEGER NOT NULL
);

CREATE TABLE ticket_exports (               -- §10.5; written by the supervisor (amendment 5)
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  target TEXT NOT NULL,                     -- 'markdown'|'jira'|…
  external_key TEXT, url TEXT, path TEXT,
  direction TEXT NOT NULL DEFAULT 'push',
  content_hash TEXT, state TEXT NOT NULL DEFAULT 'pending',   -- pending|synced|failed
  last_synced_at INTEGER, error TEXT,
  PRIMARY KEY (ticket_id, target)
);

-- ─── hand-offs (§7) ──────────────────────────────────────────────────────────
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  from_session_id TEXT REFERENCES sessions(id),
  to_session_id TEXT REFERENCES sessions(id),
  reason TEXT NOT NULL,                     -- context_ceiling|turn_ceiling|budget|phase_change|
                                            -- role_change|human_release|session_death|operator
  phase_from TEXT, phase_to TEXT,
  -- daemon-generated facts
  facts_json TEXT NOT NULL,                 -- branch, base/head sha, files touched, cmd results,
                                            -- gates, findings open, submodule shas
  -- agent-written judgement
  goal_line TEXT, decisions_md TEXT, traps_md TEXT, next_steps_md TEXT, open_questions_md TEXT,
  pointers_json TEXT,                       -- plan doc, review output, knowledge ids, log paths
  quality TEXT NOT NULL DEFAULT 'full',     -- full|degraded (daemon-reconstructed after death)
  packet_path TEXT NOT NULL,                -- .foreman/handoff-<n>.md inside the worktree
  packet_hash TEXT NOT NULL, tokens_est INTEGER,
  accepted_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX handoffs_ticket_idx ON handoffs(ticket_id, created_at);

-- ─── gates, findings ─────────────────────────────────────────────────────────
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
-- Not in §4: the UNIQUE above never fires when repo_id is NULL (a single-repo ticket), since
-- NULLs never compare equal. This index makes one gate per (ticket, kind, repo, attempt) hold.
CREATE UNIQUE INDEX gates_attempt_idx ON gates(ticket_id, kind, coalesce(repo_id, ''), attempt);

CREATE TABLE findings (
  id TEXT PRIMARY KEY, gate_id TEXT NOT NULL REFERENCES gates(id),
  severity TEXT NOT NULL CHECK (severity IN ('blocker','major','minor','nit')),
  category TEXT, file TEXT, line INTEGER, summary TEXT NOT NULL, detail_md TEXT,
  status TEXT NOT NULL DEFAULT 'open', resolved_by_run_id TEXT REFERENCES runs(id),
  resolution_note TEXT, created_at INTEGER NOT NULL
);

-- ─── coordination: mailbox, human requests, approvals ────────────────────────
CREATE TABLE messages (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
  from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL,
  kind TEXT NOT NULL, subject TEXT NOT NULL, body_md TEXT NOT NULL,
  ticket_id TEXT REFERENCES tickets(id), correlation_id TEXT,
  requires_ack INTEGER DEFAULT 0, delivered_at INTEGER, read_at INTEGER, acked_at INTEGER
);
CREATE INDEX messages_inbox_idx ON messages(to_id, read_at, ts);

CREATE TABLE human_requests (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id),
  ticket_id TEXT REFERENCES tickets(id), kind TEXT NOT NULL,
  question TEXT NOT NULL, context_md TEXT, options_json TEXT, batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', answer_json TEXT, answered_by TEXT,
  asked_at INTEGER NOT NULL, answered_at INTEGER, expires_at INTEGER
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT REFERENCES runs(id), tool TEXT NOT NULL, input_json TEXT NOT NULL,
  risk TEXT NOT NULL, decision TEXT, decided_by TEXT, policy_rule TEXT,
  requested_at INTEGER NOT NULL, decided_at INTEGER, timeout_at INTEGER
);

-- ─── knowledge, role bindings ────────────────────────────────────────────────
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_ref TEXT, kind TEXT NOT NULL,
  title TEXT NOT NULL, body_md TEXT NOT NULL,
  source_ticket_id TEXT REFERENCES tickets(id), source_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed', promoted_path TEXT,
  hits INTEGER DEFAULT 0, dedupe_key TEXT,
  created_at INTEGER NOT NULL, reviewed_at INTEGER
);

CREATE TABLE role_bindings (                -- who runs what: operator-chosen, defaults shipped (§9.8)
  role TEXT PRIMARY KEY,                    -- 'orchestrator','builder','plan_reviewer',
                                            -- 'code_reviewer','investigator','qa','util'
  runner_id TEXT NOT NULL REFERENCES runners(id),
  model_tier TEXT,                          -- null = take the run class default
  executor_id TEXT REFERENCES executors(id),
  profile_id TEXT REFERENCES profiles(id),
  fallback_runner_id TEXT REFERENCES runners(id),   -- used if primary unhealthy/uncertified
  require_distinct_from TEXT,               -- e.g. code_reviewer.require_distinct_from='builder'
  updated_by TEXT, updated_at INTEGER NOT NULL
);

-- ─── sessions: one token, one session (§11.1) ────────────────────────────────
CREATE UNIQUE INDEX sessions_mcp_token_idx ON sessions(mcp_token_hash);

-- ─── search (amendment 3) ────────────────────────────────────────────────────
CREATE VIRTUAL TABLE tickets_fts USING fts5(title, body_md, content='tickets', content_rowid='num');

CREATE TRIGGER tickets_fts_insert AFTER INSERT ON tickets BEGIN
  INSERT INTO tickets_fts (rowid, title, body_md) VALUES (new.num, new.title, new.body_md);
END;
CREATE TRIGGER tickets_fts_delete AFTER DELETE ON tickets BEGIN
  INSERT INTO tickets_fts (tickets_fts, rowid, title, body_md)
  VALUES ('delete', old.num, old.title, old.body_md);
END;
CREATE TRIGGER tickets_fts_update AFTER UPDATE OF num, title, body_md ON tickets BEGIN
  INSERT INTO tickets_fts (tickets_fts, rowid, title, body_md)
  VALUES ('delete', old.num, old.title, old.body_md);
  INSERT INTO tickets_fts (rowid, title, body_md) VALUES (new.num, new.title, new.body_md);
END;

-- The tickets 001 already holds.
INSERT INTO tickets_fts (tickets_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE knowledge_fts USING fts5(ref UNINDEXED, title, body_md);

CREATE TRIGGER knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts (ref, title, body_md) VALUES (new.id, new.title, new.body_md);
END;
CREATE TRIGGER knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
  DELETE FROM knowledge_fts WHERE ref = old.id;
END;
CREATE TRIGGER knowledge_fts_update AFTER UPDATE OF id, title, body_md ON knowledge BEGIN
  DELETE FROM knowledge_fts WHERE ref = old.id;
  INSERT INTO knowledge_fts (ref, title, body_md) VALUES (new.id, new.title, new.body_md);
END;

CREATE VIRTUAL TABLE handoffs_fts USING fts5(ref UNINDEXED, goal_line, decisions_md, traps_md,
                                             next_steps_md);

CREATE TRIGGER handoffs_fts_insert AFTER INSERT ON handoffs BEGIN
  INSERT INTO handoffs_fts (ref, goal_line, decisions_md, traps_md, next_steps_md)
  VALUES (new.id, new.goal_line, new.decisions_md, new.traps_md, new.next_steps_md);
END;
CREATE TRIGGER handoffs_fts_delete AFTER DELETE ON handoffs BEGIN
  DELETE FROM handoffs_fts WHERE ref = old.id;
END;
CREATE TRIGGER handoffs_fts_update
  AFTER UPDATE OF id, goal_line, decisions_md, traps_md, next_steps_md ON handoffs BEGIN
  DELETE FROM handoffs_fts WHERE ref = old.id;
  INSERT INTO handoffs_fts (ref, goal_line, decisions_md, traps_md, next_steps_md)
  VALUES (new.id, new.goal_line, new.decisions_md, new.traps_md, new.next_steps_md);
END;

-- ─── views (§4.1) ────────────────────────────────────────────────────────────
CREATE VIEW v_needs_attention AS
  SELECT 'stale_session' AS why, s.id AS ref, s.ticket_id FROM sessions s
    WHERE s.state IN ('running','idle') AND s.last_event_at < unixepoch()*1000 - 1800000
  UNION ALL SELECT 'handoff_pending', h.id, h.ticket_id FROM handoffs h
    WHERE h.to_session_id IS NULL
  UNION ALL SELECT 'unstaffed_ready', t.id, t.id FROM tickets t
    WHERE t.status='prioritized' AND t.owner_session_id IS NULL
  UNION ALL SELECT 'gate_stuck', g.id, g.ticket_id FROM gates g
    WHERE g.state='failed' OR (g.state='running' AND g.started_at < unixepoch()*1000 - 900000)
  UNION ALL SELECT DISTINCT 'findings_open', f.gate_id, g.ticket_id FROM findings f
    JOIN gates g ON g.id=f.gate_id WHERE f.status='open' AND f.severity IN ('blocker','major')
  UNION ALL SELECT 'unanswered_human', h.id, h.ticket_id FROM human_requests h
    WHERE h.status='open' AND h.asked_at < unixepoch()*1000 - 86400000
  UNION ALL SELECT 'unread_message', m.id, m.ticket_id FROM messages m
    WHERE m.to_kind='agent' AND m.read_at IS NULL
  UNION ALL SELECT 'export_failed', e.target, e.ticket_id FROM ticket_exports e
    WHERE e.state='failed';

CREATE VIEW v_ticket_economics AS            -- the number that matters, §8.9
  SELECT t.id, t.num, t.title, t.status, t.complexity_tier,
         (SELECT coalesce(sum(sp.cost_usd), 0) FROM spend sp
           WHERE sp.ticket_id = t.id) AS cost_usd,
         (SELECT coalesce(sum(sp.cost_usd), 0) FROM spend sp
           WHERE sp.ticket_id = t.id AND sp.wasted = 1) AS cost_wasted_usd,
         -- a review round is one code_review attempt, however many repos it covers
         (SELECT count(DISTINCT g.attempt) FROM gates g
           WHERE g.ticket_id = t.id AND g.kind = 'code_review') AS review_rounds,
         (SELECT count(*) FROM handoffs h WHERE h.ticket_id = t.id) AS handoff_count,
         (SELECT count(*) FROM sessions s WHERE s.ticket_id = t.id) AS sessions,
         (SELECT coalesce(sum(sp.tokens_in + sp.tokens_out), 0) FROM spend sp
           WHERE sp.ticket_id = t.id) AS tokens,
         (SELECT avg(sp.cache_hit_ratio) FROM spend sp WHERE sp.ticket_id = t.id) AS cache_ratio
  FROM tickets t;
