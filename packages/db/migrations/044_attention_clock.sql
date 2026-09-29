-- 044_attention_clock: v_needs_attention stops reading SQLite's own clock.
--
-- Five arms compared a timestamp with `unixepoch()` -- the OS clock -- while every other read of
-- time in packages/db takes `now` from the Db's clock, the one the caller injected. Under a fake
-- clock the view and the rest disagreed, and tests seeded at a fixed date broke the day real time
-- passed it. A view takes no parameter, so the age cut moves to the reader:
--
--   since      the timestamp an arm's wait runs from: a session's last_event_at, a running gate's
--              started_at, a question's asked_at, a review ticket's last update or gate decision.
--   after_ms   how long that wait runs before the row is listed: the number the arm held before
--              (watchdog.silent_ms or 30 min, 15 min, a day, 5 min). NULL: listed as it matches.
--
-- A row stands at `now` when `after_ms IS NULL OR since < now - after_ms`: the old predicate with
-- the injected now for `unixepoch()*1000`, and a NULL `since` on a timed arm still never listed.
-- Every other predicate is 043's text. budget_warn leaves the view: its rule is a sum over the UTC
-- day or month holding now, which no column can carry, and the reader computes it with the same SQL
-- over core's budgetWindow. So the raw view lists timed rows at any age: it is read only through
-- packages/db's attentionAt(now), which adds both.
DROP VIEW v_needs_attention;
CREATE VIEW v_needs_attention AS
  SELECT 'stale_session' AS why, s.id AS ref, s.ticket_id, s.last_event_at AS since,
         coalesce((SELECT CAST(value_json AS INTEGER) FROM settings WHERE key='watchdog.silent_ms'), 1800000)
           AS after_ms
    FROM sessions s
    WHERE s.state IN ('running','idle')
  UNION ALL SELECT 'handoff_pending', h.id, h.ticket_id, NULL, NULL FROM handoffs h
    WHERE h.accepted_at IS NULL AND h.quality <> 'writing'
  UNION ALL SELECT 'unstaffed_ready', t.id, t.id, NULL, NULL FROM tickets t
    WHERE t.status='prioritized' AND t.owner_session_id IS NULL
  -- A gate running past the 15-minute gate wall clock: as it always was -- except a CI gate (043),
  -- which runs nothing and waits for its project's own CI wait (an hour by default). Held to the
  -- gate clock it would read as stuck for most of every healthy wait; past its own deadline the CI
  -- sweep decides it `timeout`, and the failed arm below lists it then.
  UNION ALL SELECT 'gate_stuck', g.id, g.ticket_id, g.started_at, 900000 FROM gates g
    WHERE g.state='running' AND g.subject_kind <> 'pull_request'
  -- 035: a failed gate only while the ticket still waits behind it. It is the latest attempt of its
  -- (ticket, kind, repo) -- an older failure a newer attempt answered is history, not a stall -- the
  -- ticket sits in the status that kind is decided in (GATE_REVIEW_STATUS: a plan review the ticket
  -- has moved past holds nothing), and no gate of the ticket is running (a round still deciding is
  -- not stuck yet). A superseded review counts too when the ticket is back in its status: a ticket
  -- reclaimed into code_review has nothing that will reopen its round.
  UNION ALL SELECT 'gate_stuck', g.id, g.ticket_id, NULL, NULL FROM gates g
    JOIN tickets t ON t.id = g.ticket_id
    WHERE g.state = 'failed'
      AND t.status = CASE g.kind WHEN 'plan_review' THEN 'plan_review'
                                 WHEN 'qa_harness' THEN 'qa_harness'
                                 WHEN 'human_qa' THEN 'qa_human'
                                 ELSE 'code_review' END
      AND NOT EXISTS (SELECT 1 FROM gates n
                        WHERE n.ticket_id = g.ticket_id AND n.kind = g.kind
                          AND n.repo_id IS g.repo_id AND n.attempt > g.attempt)
      AND NOT EXISTS (SELECT 1 FROM gates r
                        WHERE r.ticket_id = g.ticket_id AND r.state = 'running')
  UNION ALL SELECT DISTINCT 'findings_open', f.gate_id, g.ticket_id, NULL, NULL FROM findings f
    JOIN gates g ON g.id=f.gate_id WHERE f.status='open' AND f.severity IN ('blocker','major')
  UNION ALL SELECT 'unanswered_human', h.id, h.ticket_id, h.asked_at, 86400000 FROM human_requests h
    WHERE h.status='open'
  UNION ALL SELECT 'unread_message', m.id, m.ticket_id, NULL, NULL FROM messages m
    WHERE m.to_kind='agent' AND m.read_at IS NULL
  UNION ALL SELECT 'export_failed', e.target, e.ticket_id, NULL, NULL FROM ticket_exports e
    WHERE e.state='failed'
  -- A ticket that can still be split (not closed, not split, below autosplit.max_depth) and whose
  -- hand-offs reached autosplit.handoff_threshold (§7.5). A missing setting yields no rows.
  -- 022: `phase_change` rows are not counted. §7.5's signal is "repeated hand-offs on one ticket
  -- mean the ticket was too big"; a phase-boundary hand-off means the opposite -- the
  -- ticket made normal progress -- and a ticket that crosses spike -> build -> review -> fix would
  -- otherwise read as three hand-offs before any ceiling was ever hit.
  UNION ALL SELECT 'split_candidate', t.id, t.id, NULL, NULL FROM tickets t
    WHERE t.status NOT IN ('done','rejected','split')
      AND t.split_depth <
          (SELECT CAST(value_json AS INTEGER) FROM settings WHERE key='autosplit.max_depth')
      AND (SELECT count(*) FROM handoffs h
             WHERE h.ticket_id = t.id AND h.reason <> 'phase_change') >=
          (SELECT CAST(value_json AS INTEGER) FROM settings WHERE key='autosplit.handoff_threshold')
  -- 044: budget_warn is not here. Its rule is a sum over the UTC day or month holding now, which no
  -- column can carry without a clock; the repository reader (attentionAt) computes it, over
  -- core's budgetWindow of the injected now, as listBudgets does.
  -- A worktree kept because it holds uncommitted work (§9.2, §9.6 step 6): never deleted, so a
  -- human decides. 015: the sweep's flag (kept_reason) or reviewer cleanup's old `dirty` state; the
  -- two worktree arms are exclusive, and a removed row is never listed.
  UNION ALL SELECT 'worktree_dirty', wt.id, wt.ticket_id, NULL, NULL FROM worktrees wt
    WHERE wt.state <> 'removed'
      AND (wt.kept_reason = 'dirty' OR (wt.kept_reason IS NULL AND wt.state = 'dirty'))
  -- A worktree the sweep kept for a reason other than uncommitted work (015): ignored files outside
  -- the disposable list, a lock, a commit no shared ref holds, a check that could not run, or a
  -- removal that failed half way. A human decides; the pulse never runs for it (HUMAN_ONLY_ARMS).
  UNION ALL SELECT 'worktree_kept', wt.id, wt.ticket_id, NULL, NULL FROM worktrees wt
    WHERE wt.state <> 'removed'
      AND wt.kept_reason IN ('ignored','locked','unpublished','unverifiable','remove_failed')
  -- An enabled executor whose last health check failed (§6.1, §13.2); health_detail says why.
  UNION ALL SELECT 'executor_unhealthy', x.id, NULL, NULL, NULL FROM executors x
    WHERE x.enabled = 1 AND x.health = 'unhealthy'
  -- The newest backup attempt failed (§13.2); a later good one clears it.
  UNION ALL SELECT 'backup_failed', k.id, NULL, NULL, NULL FROM backups k
    WHERE k.outcome = 'failed'
      AND k.id = (SELECT id FROM backups ORDER BY ended_at DESC, id DESC LIMIT 1)
  -- 021: a ticket its own spawn left behind (§9.6 step 4, §13.1). The ticket's newest
  -- `session.spawn` is terminally failed, that command never became a session row, and nothing live
  -- holds the ticket — so it is staffable, and `ticket_staff` on it is the whole repair.
  UNION ALL SELECT 'spawn_failed', c.id, t.id, NULL, NULL
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
                       ORDER BY c2.ts DESC, c2.rowid DESC LIMIT 1)
  -- 035: a machine step not taken. The ticket rests in a status a gate decides, no gate
  -- of it runs, the status's own gate (plan_review, code_review, qa_harness: kinds named as the
  -- statuses are) is in the ticket's current round (023), and every latest attempt the round requires
  -- passed or was waived -- yet nothing has moved it for 5 minutes since its last gate decision or
  -- update. The round's kinds are core's ROUND_KINDS; a trivial ticket owes no ce_review and a
  -- non-trivial one owes one, as `pass_review` reads them. The decision's own transaction and the
  -- reconciler's sweep take these steps; this is the net that shows one they missed.
  UNION ALL SELECT 'advance_pending', t.id, t.id,
         max(t.updated_at,
             coalesce((SELECT max(d.decided_at) FROM gates d WHERE d.ticket_id = t.id), 0)),
         300000
    FROM tickets t
    WHERE t.status IN ('plan_review','code_review','qa_harness')
      AND NOT EXISTS (SELECT 1 FROM gates r WHERE r.ticket_id = t.id AND r.state = 'running')
      AND EXISTS (SELECT 1 FROM gates a
                    WHERE a.ticket_id = t.id AND a.kind = t.status
                      AND a.round = (SELECT max(m.round) FROM gates m WHERE m.ticket_id = t.id))
      AND NOT (t.status = 'code_review' AND t.non_trivial = 1
               AND NOT EXISTS (SELECT 1 FROM gates c
                                 WHERE c.ticket_id = t.id AND c.kind = 'ce_review'
                                   AND c.round = (SELECT max(m.round) FROM gates m
                                                    WHERE m.ticket_id = t.id)))
      AND NOT EXISTS (SELECT 1 FROM gates g
                        WHERE g.ticket_id = t.id
                          AND g.round = (SELECT max(m.round) FROM gates m WHERE m.ticket_id = t.id)
                          AND (CASE t.status
                                 WHEN 'code_review'
                                   THEN g.kind IN ('code_review','parity_check','lint_check')
                                        OR (g.kind = 'ce_review' AND t.non_trivial = 1)
                                 ELSE g.kind = t.status END)
                          AND g.state NOT IN ('passed','waived')
                          AND NOT EXISTS (SELECT 1 FROM gates n
                                            WHERE n.ticket_id = g.ticket_id AND n.kind = g.kind
                                              AND n.repo_id IS g.repo_id AND n.attempt > g.attempt));
