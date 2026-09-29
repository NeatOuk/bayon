-- Reverts 015_worktree_sweep: v_needs_attention goes back to 012's text byte for byte, then the
-- columns and the sweep's settings go.
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
ALTER TABLE worktrees DROP COLUMN kept_detail;
ALTER TABLE worktrees DROP COLUMN kept_reason;
DELETE FROM settings WHERE key IN (
  'worktree.mirror_tmp_min_age_ms',
  'worktree.min_ended_ms',
  'worktree.remove_timeout_ms',
  'worktree.request_min_gap_ms',
  'worktree.disposable_ignored'
);
