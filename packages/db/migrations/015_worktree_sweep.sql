-- 015_worktree_sweep (M4): what the worktree sweep writes and reads (spec §9.6 step 6,
-- §9.2, "Amendments — M4"; the design §9). It adds:
--   worktrees.kept_reason  why the sweep kept a worktree for a human: dirty, ignored, locked,
--               unpublished, unverifiable or remove_failed; NULL when there is nothing to flag. The
--               sweep writes this column, never worktrees.state, which laws and gates read (§2).
--   worktrees.kept_detail  what the flag is about, at most 500 characters (the writer caps it):
--               paths, a lock reason, a SHA or git's stderr tail, never file content.
--   settings    the sweep's thresholds, INSERT OR IGNORE as in 012 and 013. A missing or malformed
--               row turns removal off while flagging continues (NEW-7).
--   v_needs_attention  rebuilt: 012's arms byte for byte, but worktree_dirty reads the flag too, and
--               a new worktree_kept arm, exclusive of it, lists the sweep's other reasons.
ALTER TABLE worktrees ADD COLUMN kept_reason TEXT
  CHECK (kept_reason IN ('dirty','ignored','locked','unpublished','unverifiable','remove_failed'));
ALTER TABLE worktrees ADD COLUMN kept_detail TEXT;

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES
  ('worktree.mirror_tmp_min_age_ms', '86400000', unixepoch() * 1000),
  ('worktree.min_ended_ms',          '3600000', unixepoch() * 1000),
  ('worktree.remove_timeout_ms',     '900000', unixepoch() * 1000),
  ('worktree.request_min_gap_ms',    '60000', unixepoch() * 1000),
  ('worktree.disposable_ignored',    '["node_modules/","dist/","build/","target/",".venv/","__pycache__/",".pytest_cache/",".mypy_cache/",".ruff_cache/",".turbo/",".next/","coverage/"]', unixepoch() * 1000);

-- ─── v_needs_attention (§4.1; M4) ────────────────────────────────────────────
-- Every 012 arm as it was, byte for byte, except the worktree arms.
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
  -- human decides. 015: the sweep's flag (kept_reason) or reviewer cleanup's old `dirty` state; the
  -- two worktree arms are exclusive, and a removed row is never listed.
  UNION ALL SELECT 'worktree_dirty', wt.id, wt.ticket_id FROM worktrees wt
    WHERE wt.state <> 'removed'
      AND (wt.kept_reason = 'dirty' OR (wt.kept_reason IS NULL AND wt.state = 'dirty'))
  -- A worktree the sweep kept for a reason other than uncommitted work (015): ignored files outside
  -- the disposable list, a lock, a commit no shared ref holds, a check that could not run, or a
  -- removal that failed half way. A human decides; the pulse never runs for it (HUMAN_ONLY_ARMS).
  UNION ALL SELECT 'worktree_kept', wt.id, wt.ticket_id FROM worktrees wt
    WHERE wt.state <> 'removed'
      AND wt.kept_reason IN ('ignored','locked','unpublished','unverifiable','remove_failed')
  -- An enabled executor whose last health check failed (§6.1, §13.2); health_detail says why.
  UNION ALL SELECT 'executor_unhealthy', x.id, NULL FROM executors x
    WHERE x.enabled = 1 AND x.health = 'unhealthy'
  -- The newest backup attempt failed (§13.2); a later good one clears it.
  UNION ALL SELECT 'backup_failed', k.id, NULL FROM backups k
    WHERE k.outcome = 'failed'
      AND k.id = (SELECT id FROM backups ORDER BY ended_at DESC, id DESC LIMIT 1);
