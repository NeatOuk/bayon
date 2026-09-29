-- Reverts 012_fleet: v_needs_attention goes back to 005's text byte for byte, then the tables, the
-- column and the M4 settings go. budget.daily_cap_usd stays (002's), whatever budgets held.
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
          (SELECT CAST(value_json AS INTEGER) FROM settings WHERE key='autosplit.handoff_threshold');

DROP TABLE backups;
DROP TABLE budgets;
ALTER TABLE sessions DROP COLUMN queued_reason;
DELETE FROM settings WHERE key IN (
  'fleet.paused', 'admission.recheck_ms', 'admission.disk_min_free_pct',
  'admission.require_certified', 'reconciler.command_requeue_ms', 'worktree.recheck_ms',
  'watchdog.silent_ms', 'watchdog.retry_storm_count', 'watchdog.retry_storm_window_ms',
  'watchdog.retry_storm_backoff_ms', 'watchdog.circuit_failed_runs',
  'executor.clock_skew_max_ms', 'backup.enabled', 'backup.at_utc_hour', 'backup.keep'
);
