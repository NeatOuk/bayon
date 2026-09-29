-- 012_fleet (M4): the schema the M4 tickets read (spec "Amendments — M4"). It adds:
--   budgets     §4 / §13.4: scope fleet or agent, period day or month (UTC). §4's spent_usd,
--               spent_tokens and window_start are not stored: spent is computed from spend at read
--               time, over the UTC day or month that holds now, so nothing rolls a window. A budget
--               names at least one cap, and on_breach 'kill' is refused by a CHECK (deferred past
--               M4). API-owned: the operator sets it through REST (§12.1 /budgets).
--   backups     the smallest shape M4-k's writer fills: one row per finished attempt. The newest
--               row's outcome drives backup_failed. The supervisor writes it (the nightly job).
--   sessions.queued_reason  why a pending session is queued (§9.1): one of the queue-side
--               AdmissionGate values M4-b defines, so no CHECK here. NULL when not queued.
--   settings    every M4 setting (the plan's contracts), INSERT OR IGNORE as in 011.
--   v_needs_attention  rebuilt: 005's arms byte for byte, then budget_warn (§4.1's arm, spent
--               computed), worktree_dirty, executor_unhealthy and backup_failed.
-- executors.health_detail is 010's; executor_unhealthy keys on executors.health, which the health
-- check sets from the same verdict. budget.daily_cap_usd stays: the M2 staffing check, the pulse
-- gate and the Fleet bar read it until M4-c moves them to budgets.

-- ─── budgets (§4, §13.4) ─────────────────────────────────────────────────────
CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('fleet','agent')),
  scope_ref TEXT REFERENCES agents(id),     -- the agent of an agent budget; NULL for the fleet
  period TEXT NOT NULL CHECK (period IN ('day','month')),   -- a UTC day or month
  cap_usd REAL CHECK (cap_usd >= 0),
  cap_tokens INTEGER CHECK (cap_tokens >= 0),               -- tokens_in + tokens_out
  warn_pct INTEGER NOT NULL DEFAULT 70 CHECK (warn_pct BETWEEN 1 AND 100),
  on_breach TEXT NOT NULL DEFAULT 'pause_admission'
    CHECK (on_breach IN ('warn','pause_admission')),        -- 'kill': deferred past M4
  updated_at INTEGER NOT NULL,
  CHECK ((scope = 'fleet') = (scope_ref IS NULL)),
  CHECK (cap_usd IS NOT NULL OR cap_tokens IS NOT NULL)
);
-- One budget per scope and period.
CREATE UNIQUE INDEX budgets_scope_idx ON budgets(scope, coalesce(scope_ref, ''), period);

-- The daily cap becomes a fleet/day budget when it is a number; 002 seeds it null (no row). The
-- id is a ULID like every id: ten Crockford base-32 digits of the epoch millis, then sixteen
-- random ones.
WITH RECURSIVE
  ulid_digits(i, digit) AS (
    SELECT 0, ''
    UNION ALL
    SELECT i + 1,
           substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                  1 + CASE WHEN i < 10 THEN ((unixepoch() * 1000) >> (5 * (9 - i))) & 31
                           ELSE abs(random() % 32) END, 1)
    FROM ulid_digits WHERE i < 26
  )
INSERT INTO budgets (id, scope, scope_ref, period, cap_usd, updated_at)
SELECT (SELECT group_concat(digit, '' ORDER BY i) FROM ulid_digits),
       'fleet', NULL, 'day', CAST(value_json AS REAL), unixepoch() * 1000
FROM settings
WHERE key = 'budget.daily_cap_usd'
  AND CASE WHEN json_valid(value_json) THEN json_type(value_json) END IN ('integer','real')
  AND CAST(value_json AS REAL) >= 0;

-- ─── backups (§13.2, §14; M4-k writes them) ──────────────────────────────────
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL CHECK (ended_at >= started_at),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','failed')),
  path TEXT,                                -- the encrypted file an ok attempt wrote
  error TEXT,                               -- why a failed attempt failed
  CHECK (outcome <> 'ok' OR path IS NOT NULL),
  CHECK (outcome <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX backups_ended_idx ON backups(ended_at);

-- ─── sessions (§9.1) ─────────────────────────────────────────────────────────
ALTER TABLE sessions ADD COLUMN queued_reason TEXT;

-- ─── settings (M4 contracts) ─────────────────────────────────────────────────
-- OR IGNORE: a key the operator already set keeps its value. Flags are 0/1, as in 002.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES
  ('fleet.paused',                    '0',       unixepoch() * 1000),
  ('admission.recheck_ms',            '5000',    unixepoch() * 1000),
  ('admission.disk_min_free_pct',     '10',      unixepoch() * 1000),
  ('admission.require_certified',     '1',       unixepoch() * 1000),
  ('reconciler.command_requeue_ms',   '300000',  unixepoch() * 1000),
  ('worktree.recheck_ms',             '3600000', unixepoch() * 1000),
  ('watchdog.silent_ms',              '1800000', unixepoch() * 1000),
  ('watchdog.retry_storm_count',      '5',       unixepoch() * 1000),
  ('watchdog.retry_storm_window_ms',  '600000',  unixepoch() * 1000),
  ('watchdog.retry_storm_backoff_ms', '900000',  unixepoch() * 1000),
  ('watchdog.circuit_failed_runs',    '3',       unixepoch() * 1000),
  ('executor.clock_skew_max_ms',      '5000',    unixepoch() * 1000),
  ('backup.enabled',                  '1',       unixepoch() * 1000),
  ('backup.at_utc_hour',              '3',       unixepoch() * 1000),
  ('backup.keep',                     '14',      unixepoch() * 1000);

-- ─── v_needs_attention (§4.1; M4) ────────────────────────────────────────────
-- Every 005 arm as it was, byte for byte; the four M4 arms follow it.
DROP VIEW v_needs_attention;
CREATE VIEW v_needs_attention AS
  SELECT 'stale_session' AS why, s.id AS ref, s.ticket_id FROM sessions s
    WHERE s.state IN ('running','idle') AND s.last_event_at < unixepoch()*1000 - 1800000
  UNION ALL SELECT 'handoff_pending', h.id, h.ticket_id FROM handoffs h
    WHERE h.accepted_at IS NULL AND h.quality <> 'writing'
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
          (SELECT CAST(value_json AS INTEGER) FROM settings WHERE key='autosplit.handoff_threshold')
  -- A budget at warn_pct of a cap or past it (§4.1, §13.4). Spent is computed here, over the UTC
  -- day or month holding now and within the budget's scope (the fleet, or the agent's sessions);
  -- listBudgets computes the same sums with the Db's clock.
  UNION ALL SELECT 'budget_warn', b.id, NULL FROM (
      SELECT bu.id, bu.scope, bu.scope_ref, bu.cap_usd, bu.cap_tokens, bu.warn_pct,
             unixepoch('now', CASE bu.period WHEN 'day' THEN 'start of day'
                                             ELSE 'start of month' END) * 1000 AS window_start,
             unixepoch('now', CASE bu.period WHEN 'day' THEN 'start of day'
                                             ELSE 'start of month' END,
                              CASE bu.period WHEN 'day' THEN '+1 day'
                                             ELSE '+1 month' END) * 1000 AS window_end
      FROM budgets bu) b
    LEFT JOIN spend sp ON sp.ts >= b.window_start AND sp.ts < b.window_end
      AND (b.scope = 'fleet'
           OR sp.session_id IN (SELECT s.id FROM sessions s WHERE s.agent_id = b.scope_ref))
    GROUP BY b.id
    HAVING (b.cap_usd IS NOT NULL
            AND coalesce(sum(sp.cost_usd), 0) >= b.cap_usd * b.warn_pct / 100.0)
        OR (b.cap_tokens IS NOT NULL
            AND coalesce(sum(sp.tokens_in + sp.tokens_out), 0) >= b.cap_tokens * b.warn_pct / 100.0)
  -- A worktree kept because it holds uncommitted work (§9.2, §9.6 step 6): never deleted, so a
  -- human decides. It leaves when the worktree is cleaned or removed.
  UNION ALL SELECT 'worktree_dirty', wt.id, wt.ticket_id FROM worktrees wt
    WHERE wt.state = 'dirty'
  -- An enabled executor whose last health check failed (§6.1, §13.2); health_detail says why.
  UNION ALL SELECT 'executor_unhealthy', x.id, NULL FROM executors x
    WHERE x.enabled = 1 AND x.health = 'unhealthy'
  -- The newest backup attempt failed (§13.2); a later good one clears it.
  UNION ALL SELECT 'backup_failed', k.id, NULL FROM backups k
    WHERE k.outcome = 'failed'
      AND k.id = (SELECT id FROM backups ORDER BY ended_at DESC, id DESC LIMIT 1);
