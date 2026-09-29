-- 022_phase_change_handoffs (M4): a phase-boundary hand-off is progress, not a size
-- signal.
--
-- §7.1 row four -- `phase_change`, "daemon (new class, new session)" -- has been in the spec and in
-- `HandoffReason` since M2 with nothing emitting it. an earlier change wires it: a transition that leaves a
-- ticket asking for a run class its holder does not carry ships a `session.handoff` with the move,
-- so the phase's session ends instead of holding the ticket for ever.
--
-- That makes hand-offs routine, and two places count them as if every one were a ceiling:
--
--   * `v_needs_attention`'s `split_candidate` arm, against `autosplit.handoff_threshold` (4 by
--     default). A ticket that crosses three boundaries and hits one context ceiling would read as
--     four hand-offs and page the operator (`watchdog/split.ts` files a `human_request` per
--     threshold value) about a ticket behaving exactly as designed.
--   * `v_ticket_economics.handoff_count`, which §7.5 reads as "repeated hand-offs on one ticket
--     mean the ticket was too big" -- and which `spend-rollups.ts` averages into `handoffs_avg`.
--
-- Both now count only the hand-offs that say something about the ticket's size. Nothing is lost:
-- `phase_handoff_count` carries the excluded rows, so the total is still `handoff_count +
-- phase_handoff_count` and the GUI can show both against the hand-off list beside them.
--
-- v_needs_attention is otherwise 021's text byte for byte, `spawn_failed` arm included, so the
-- migration test can compare the rest arm by arm.
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
  -- 022: `phase_change` rows are not counted. §7.5's signal is "repeated hand-offs on one ticket
  -- mean the ticket was too big"; a phase-boundary hand-off means the opposite -- the
  -- ticket made normal progress -- and a ticket that crosses spike -> build -> review -> fix would
  -- otherwise read as three hand-offs before any ceiling was ever hit.
  UNION ALL SELECT 'split_candidate', t.id, t.id FROM tickets t
    WHERE t.status NOT IN ('done','rejected','split')
      AND t.split_depth <
          (SELECT CAST(value_json AS INTEGER) FROM settings WHERE key='autosplit.max_depth')
      AND (SELECT count(*) FROM handoffs h
             WHERE h.ticket_id = t.id AND h.reason <> 'phase_change') >=
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
      AND k.id = (SELECT id FROM backups ORDER BY ended_at DESC, id DESC LIMIT 1)
  -- 021: a ticket its own spawn left behind (§9.6 step 4, §13.1). The ticket's newest
  -- `session.spawn` is terminally failed, that command never became a session row, and nothing live
  -- holds the ticket — so it is staffable, and `ticket_staff` on it is the whole repair.
  UNION ALL SELECT 'spawn_failed', c.id, t.id
    FROM commands c
    JOIN tickets t ON t.id = json_extract(c.payload_json, '$.ticket_id')
    WHERE c.type = 'session.spawn' AND c.state = 'failed'
      AND t.status IN ('staffed','spiking','planned','building','rework','review_fix')
      -- The command died before createSessionRow: with a row, abort edge already ends
      -- the session and leaves a hand-off, and `stale_session`/`handoff_pending` carry it.
      AND NOT EXISTS (SELECT 1 FROM sessions s
                        WHERE s.id = json_extract(c.payload_json, '$.session_id'))
      -- Nothing is working the ticket now (ENDED_STATES, as v_fleet spells them).
      AND NOT EXISTS (SELECT 1 FROM sessions s
                        WHERE s.ticket_id = t.id
                          AND s.state NOT IN ('exited','resumable','handed_off'))
      -- Only the last spawn speaks for the ticket, so a re-staff clears the arm by existing: the
      -- new command is `pending`, and one failure in a ticket's history never re-lists a ticket
      -- that has moved on. Two spawns can share a `ts` (the same millisecond, and a test's frozen
      -- clock makes it certain), and a ULID's random suffix is not an ordering — so the tie breaks
      -- on rowid, the order the rows actually went in.
      AND c.rowid = (SELECT c2.rowid FROM commands c2
                       WHERE c2.type = 'session.spawn'
                         AND json_extract(c2.payload_json, '$.ticket_id') = t.id
                       ORDER BY c2.ts DESC, c2.rowid DESC LIMIT 1);

DROP VIEW v_ticket_economics;
CREATE VIEW v_ticket_economics AS            -- the number that matters, §8.9
  SELECT t.id, t.num, t.title, t.status, t.complexity_tier,
         (SELECT coalesce(sum(sp.cost_usd), 0) FROM spend sp
           WHERE sp.ticket_id = t.id) AS cost_usd,
         (SELECT coalesce(sum(sp.cost_usd), 0) FROM spend sp
           WHERE sp.ticket_id = t.id AND sp.wasted = 1) AS cost_wasted_usd,
         -- a review round is one code_review attempt, however many repos it covers
         (SELECT count(DISTINCT g.attempt) FROM gates g
           WHERE g.ticket_id = t.id AND g.kind = 'code_review') AS review_rounds,
         -- 022: the sizing signal (§7.5), so phase boundaries do not read as a ticket too big
         (SELECT count(*) FROM handoffs h
           WHERE h.ticket_id = t.id AND h.reason <> 'phase_change') AS handoff_count,
         -- 022: the boundaries themselves -- progress, counted apart
         (SELECT count(*) FROM handoffs h
           WHERE h.ticket_id = t.id AND h.reason = 'phase_change') AS phase_handoff_count,
         (SELECT count(*) FROM sessions s WHERE s.ticket_id = t.id) AS sessions,
         (SELECT coalesce(sum(sp.tokens_in + sp.tokens_out), 0) FROM spend sp
           WHERE sp.ticket_id = t.id) AS tokens,
         (SELECT avg(sp.cache_hit_ratio) FROM spend sp WHERE sp.ticket_id = t.id) AS cache_ratio
  FROM tickets t;
