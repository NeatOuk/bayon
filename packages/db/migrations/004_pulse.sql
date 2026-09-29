-- 004_pulse (M2): the §4 pulse tables, the probes §10.2 ships, the M2 settings, and
-- v_needs_attention rebuilt. The DDL is §4 verbatim except where a comment says otherwise. The M2
-- amendments it applies:
--   (c) handoff_pending has no age condition: every hand-off with accepted_at NULL is pending. A
--       hand-off never moves tickets.status, and to_session_id alone does not end it: accept does.
--   (d) The pulse lease is a pulses row in state leased or running; pulses_lease_idx makes it one
--       per agent. TTL pulse.lease_ttl_ms (the pulse wall clock + 2 min), no renewal.
--   (e) handoff_writing's budget: the handoff.* settings.
--   (g) log_scan reads foreman's own logs and its output is fenced as untrusted.
--   (i) split_candidate: an open ticket whose hand-off chain reached autosplit.handoff_threshold.
--       Splitting itself is deferred; the arm only asks.
--   A sql probe names a query in packages/db (Invariant 6): its spec_json never carries SQL.
-- tickets.origin_fingerprint is already unique (001's tickets_origin_fp_idx, §10.2), so 004 adds
-- nothing for it.

-- ─── pulses (§4, §9.7) ───────────────────────────────────────────────────────
CREATE TABLE pulses (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('cron','completion','manual','catchup')),
  scheduled_at INTEGER NOT NULL,
  lease_token TEXT, lease_expires_at INTEGER,
  state TEXT NOT NULL
    CHECK (state IN ('leased','running','done','skipped','failed','expired')),
  skip_reason TEXT,                         -- skipped: nothing_to_do|rate_capped|…; failed: why
  session_id TEXT REFERENCES sessions(id), run_id TEXT REFERENCES runs(id),
  context_pack_path TEXT, context_tokens INTEGER CHECK (context_tokens >= 0),
  summary_md TEXT, actions_json TEXT, cost_usd REAL CHECK (cost_usd >= 0),
  started_at INTEGER, ended_at INTEGER,
  -- Not in §4: a live pulse holds a lease (amendment d), and a skipped one says why.
  CHECK (state NOT IN ('leased','running')
         OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (state <> 'skipped' OR skip_reason IS NOT NULL)
);
-- The single-flight lease (amendment d): a second live pulse for one agent is a conflict.
CREATE UNIQUE INDEX pulses_lease_idx ON pulses(agent_id) WHERE state IN ('leased','running');
CREATE INDEX pulses_agent_idx ON pulses(agent_id, scheduled_at);

-- ─── probes (§10.2): deterministic checks, run by the daemon ─────────────────
-- spec_json by kind: sql {"query": <a query id in packages/db>}; shell {"argv": [...], "cwd":
-- "mirrors" (each repo's mirror clone) | "logs" ($FRM_HOME/logs)}, run with no shell. Not in §4:
-- the CHECKs on spec_json and the 0/1 flags.
CREATE TABLE probes (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sql','shell','http','script_runner')),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
  timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  untrusted_output INTEGER NOT NULL DEFAULT 0 CHECK (untrusted_output IN (0,1)),
  every_pulse INTEGER NOT NULL DEFAULT 1 CHECK (every_pulse IN (0,1)),
  -- IS, not =: json_type of a missing key is NULL, and a CHECK that yields NULL passes.
  CHECK (kind <> 'sql' OR json_type(spec_json, '$.query') IS 'text'),
  CHECK (kind <> 'shell' OR json_type(spec_json, '$.argv') IS 'array')
);

CREATE TABLE pulse_checks (
  id TEXT PRIMARY KEY, pulse_id TEXT NOT NULL REFERENCES pulses(id),
  name TEXT NOT NULL REFERENCES probes(name),
  state TEXT NOT NULL CHECK (state IN ('ok','error','timeout')),
  duration_ms INTEGER CHECK (duration_ms >= 0), result_json TEXT, result_path TEXT, error TEXT
);
CREATE INDEX pulse_checks_pulse_idx ON pulse_checks(pulse_id);

-- The probes M2 ships (§10.2; an earlier change runs them). Probes are operator config: edit the rows.
INSERT INTO probes (name, kind, spec_json, untrusted_output)
VALUES
  ('stale_sessions',  'sql',   '{"query":"stale_sessions"}',  0),
  ('handoff_pending', 'sql',   '{"query":"handoff_pending"}', 0),
  ('gate_health',     'sql',   '{"query":"gate_health"}',     0),
  ('budget',          'sql',   '{"query":"budget"}',          0),
  ('merged_prs',      'shell',
   '{"argv":["git","log","--merges","--max-count=20","--format=%H %cI %s"],"cwd":"mirrors"}', 0),
  ('log_scan',        'shell',
   '{"argv":["grep","-rEIin","--max-count=50","error|fault|fatal|panic|crash|watchdog|relaunch","."],"cwd":"logs"}',
   1);

-- ─── settings (M2 contracts) ─────────────────────────────────────────────────
-- OR IGNORE: a key the operator already set keeps its value.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES
  ('pulse.lease_ttl_ms',        '1020000', unixepoch() * 1000),
  ('handoff.max_turns',         '3',       unixepoch() * 1000),
  ('handoff.wall_clock_ms',     '300000',  unixepoch() * 1000),
  ('handoff.prompt_tokens_cap', '1500',    unixepoch() * 1000),
  ('handoff.packet_tokens_cap', '1200',    unixepoch() * 1000),
  ('preflight.margin_pct',      '15',      unixepoch() * 1000),
  ('spend.alarm_pct',           '25',      unixepoch() * 1000),
  ('spend.baseline_days',       '30',      unixepoch() * 1000);

-- ─── v_needs_attention (§4.1; amendments c and i) ────────────────────────────
-- Every 003 arm as it was, except handoff_pending; split_candidate is new.
DROP VIEW v_needs_attention;
CREATE VIEW v_needs_attention AS
  SELECT 'stale_session' AS why, s.id AS ref, s.ticket_id FROM sessions s
    WHERE s.state IN ('running','idle') AND s.last_event_at < unixepoch()*1000 - 1800000
  UNION ALL SELECT 'handoff_pending', h.id, h.ticket_id FROM handoffs h
    WHERE h.accepted_at IS NULL
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
    WHERE e.state='failed'
  -- A ticket that can still be split (not closed, not split, below autosplit.max_depth) and whose
  -- hand-offs reached autosplit.handoff_threshold (§7.5). A missing setting yields no rows.
  UNION ALL SELECT 'split_candidate', t.id, t.id FROM tickets t
    WHERE t.status NOT IN ('done','rejected','split')
      AND t.split_depth <
          (SELECT CAST(value_json AS INTEGER) FROM settings WHERE key='autosplit.max_depth')
      AND (SELECT count(*) FROM handoffs h WHERE h.ticket_id = t.id) >=
          (SELECT CAST(value_json AS INTEGER) FROM settings WHERE key='autosplit.handoff_threshold');
